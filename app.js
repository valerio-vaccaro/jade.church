import { Address, Jade, Network, Singlesig } from "lwk_wasm";

const connectBtn = document.getElementById("connect-btn");
const unlockBtn = document.getElementById("unlock-btn");
const refreshBtn = document.getElementById("refresh-btn");
const networkSelect = document.getElementById("network-select");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const message = document.getElementById("message");
const connectedContent = document.getElementById("connected-content");
const selectedNetwork = document.getElementById("selected-network");
const masterXpub = document.getElementById("master-xpub");
const xpubFingerprint = document.getElementById("xpub-fingerprint");
const masterBlindingKey = document.getElementById("master-blinding-key");
const multisigCount = document.getElementById("multisig-count");
const versionDetails = document.getElementById("version-details");
const loadDerivationsBtn = document.getElementById("load-derivations-btn");
const derivationStatus = document.getElementById("derivation-status");
const derivationIndexInput = document.getElementById("derivation-index");
const derivationChainSelect = document.getElementById("derivation-chain");
const derivationConfidential = document.getElementById("derivation-confidential");
const descriptorStatus = document.getElementById("descriptor-status");
const bip49GlobalDescriptor = document.getElementById("bip49-global-descriptor");
const bip84GlobalDescriptor = document.getElementById("bip84-global-descriptor");

const HARDENED = 0x80000000;

const derivationFormats = [
  {
    key: "bip49",
    purpose: 49,
    variant: "ShWpkh",
    label: "BIP49 (P2SH-P2WPKH)",
    panelId: "derivation-bip49"
  },
  {
    key: "bip84",
    purpose: 84,
    variant: "Wpkh",
    label: "BIP84 (P2WPKH)",
    panelId: "derivation-bip84"
  }
];
const derivationFormatByPanel = new Map(derivationFormats.map((f) => [f.panelId, f]));

let currentNetworkType = "mainnet";
let currentNetwork = Network.mainnet();

let jade = null;
let refreshInProgress = false;
let cachedXpub = null;
let derivationInProgress = false;
let descriptorsInProgress = false;
let cachedMasterBlindingKey = "-";
let disconnectInProgress = false;
let activeJadeOps = 0;

function getNetworkLabel(type = currentNetworkType) {
  return type === "testnet" ? "Testnet" : "Mainnet";
}

function getUriScheme() {
  return currentNetworkType === "testnet" ? "liquidtestnet" : "liquidnetwork";
}

function getCoinType() {
  return currentNetworkType === "testnet" ? 1 : 1776;
}

function setSelectedNetworkLabel() {
  selectedNetwork.textContent = getNetworkLabel();
}

function initTabs(buttonSelector, targetAttr, onActivate) {
  const buttons = Array.from(document.querySelectorAll(buttonSelector));
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const targetId = button.getAttribute(targetAttr);
      if (!targetId) return;
      buttons.forEach((b) => b.classList.remove("active"));
      button.classList.add("active");

      buttons.forEach((b) => {
        const id = b.getAttribute(targetAttr);
        if (!id) return;
        const panel = document.getElementById(id);
        if (!panel) return;
        panel.classList.toggle("active", id === targetId);
      });

      if (typeof onActivate === "function") {
        onActivate(targetId);
      }
    });
  });
}

function derivationPath(purpose, change, index, account = 0) {
  return new Uint32Array([
    purpose + HARDENED,
    getCoinType() + HARDENED,
    account + HARDENED,
    change,
    index
  ]);
}

function setDerivationStatus(text, isError = false) {
  derivationStatus.textContent = text;
  derivationStatus.style.color = isError ? "#f7b0b0" : "#a9beb6";
}

function setDescriptorStatus(text, isError = false) {
  descriptorStatus.textContent = text;
  descriptorStatus.style.color = isError ? "#f7b0b0" : "#a9beb6";
}

function pathToString(path) {
  return `m/${path[0] - HARDENED}'/${path[1] - HARDENED}'/${path[2] - HARDENED}'/${path[3]}/${path[4]}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function clearDerivationResults() {
  derivationFormats.forEach((format) => {
    const pathEl = document.getElementById(`${format.key}-path`);
    const addressEl = document.getElementById(`${format.key}-address`);
    const qrEl = document.getElementById(`${format.key}-qr`);
    if (pathEl) pathEl.textContent = "-";
    if (addressEl) addressEl.textContent = "-";
    if (qrEl) {
      qrEl.hidden = true;
      qrEl.removeAttribute("src");
    }
  });
  setDerivationStatus(`Connect and unlock Jade on ${getNetworkLabel()}, choose index/type, then derive.`);
}

function clearDeviceInfo() {
  masterXpub.textContent = "-";
  xpubFingerprint.textContent = "-";
  masterBlindingKey.textContent = "-";
  multisigCount.textContent = "-";
  versionDetails.innerHTML = "<div class=\"detail-item\"><div class=\"detail-label\">Status</div><div class=\"detail-value\">No version data yet.</div></div>";
  bip49GlobalDescriptor.value = "";
  bip84GlobalDescriptor.value = "";
  setDescriptorStatus(`Open Liquid Address Derivation tab to compute ${getNetworkLabel()} descriptors from Jade.`);
  cachedMasterBlindingKey = "-";
  setSelectedNetworkLabel();
  clearDerivationResults();
}

function setConnected(connected) {
  statusDot.classList.toggle("connected", connected);
  statusText.textContent = connected ? "Connected" : "Not connected";
  connectedContent.hidden = !connected;
  connectBtn.textContent = connected ? "Disconnect Jade" : "Connect to Jade";
  connectBtn.classList.toggle("secondary", connected);
  unlockBtn.disabled = !connected;
  refreshBtn.disabled = !connected;
  loadDerivationsBtn.disabled = !connected;
}

function setMessage(text, isError = false) {
  message.textContent = text;
  message.style.color = isError ? "#9a2e2e" : "#4b5f57";
}

async function closeOpenSerialPorts() {
  if (!navigator.serial || typeof navigator.serial.getPorts !== "function") return;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const ports = await navigator.serial.getPorts();
    for (const port of ports) {
      try {
        await port.close();
      } catch {
        // Ignore if already closed / not closable here.
      }
    }
    if (attempt < 3) await sleep(120);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runJadeOp(fn) {
  activeJadeOps += 1;
  try {
    return await fn();
  } finally {
    activeJadeOps = Math.max(0, activeJadeOps - 1);
  }
}

async function waitForNoActiveJadeOps(timeoutMs = 8000) {
  const started = Date.now();
  while (activeJadeOps > 0 && Date.now() - started < timeoutMs) {
    await sleep(50);
  }
}

function stringify(value) {
  if (value === undefined || value === null) return "-";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getMultisigCount(multisigs) {
  if (Array.isArray(multisigs)) return multisigs.length;
  if (multisigs && typeof multisigs === "object") return Object.keys(multisigs).length;
  return 0;
}

function renderDetail(label, value, { badge = false, warn = false } = {}) {
  const safeLabel = escapeHtml(label);
  const safeValue = escapeHtml(value ?? "-");
  const valueHtml = badge
    ? `<span class="badge${warn ? " warn" : ""}">${safeValue}</span>`
    : safeValue;
  return `<div class="detail-item"><div class="detail-label">${safeLabel}</div><div class="detail-value">${valueHtml}</div></div>`;
}

function batteryLabel(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "-";
  const normalized = Math.max(0, Math.min(5, value));
  const pct = normalized * 20;
  const level = normalized <= 1 ? "Low" : normalized <= 3 ? "Medium" : "High";
  return `${pct}% (${level})`;
}

function renderVersionDetails(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    versionDetails.innerHTML = renderDetail("Payload", "Unexpected payload format");
    return;
  }

  const state = payload.JADE_STATE ?? "-";
  const hasPin = payload.JADE_HAS_PIN;
  const isReady = String(state).toUpperCase() === "READY";
  const pinEnabled = typeof hasPin === "boolean" ? (hasPin ? "Enabled" : "Disabled") : "-";

  const rows = [
    renderDetail("Firmware", payload.JADE_VERSION ?? "-"),
    renderDetail("Board", payload.BOARD_TYPE ?? "-"),
    renderDetail("Build Config", payload.JADE_CONFIG ?? "-"),
    renderDetail("Features", payload.JADE_FEATURES ?? "-"),
    renderDetail("IDF Version", payload.IDF_VERSION ?? "-"),
    renderDetail("Networks", payload.JADE_NETWORKS ?? "-"),
    renderDetail("State", state, { badge: true, warn: !isReady }),
    renderDetail("PIN", pinEnabled, { badge: true, warn: pinEnabled !== "Enabled" }),
    renderDetail("Battery", batteryLabel(payload.BATTERY_STATUS), { badge: true, warn: (payload.BATTERY_STATUS ?? 0) <= 1 }),
    renderDetail("OTA Max Chunk", payload.JADE_OTA_MAX_CHUNK ? `${payload.JADE_OTA_MAX_CHUNK} bytes` : "-"),
    renderDetail("Chip Features", payload.CHIP_FEATURES ?? "-"),
    renderDetail("EFUSE MAC", payload.EFUSEMAC ?? "-")
  ];

  versionDetails.innerHTML = rows.join("");
}

function extractSlip77FromDescriptor(descriptorStr) {
  const match = String(descriptorStr).match(/slip77\(([0-9a-fA-F]+)\)/);
  return match ? match[1] : "-";
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

async function ensureJadeUnlocked() {
  if (!jade) throw new Error("No Jade connection");

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      setMessage(`Unlock attempt ${attempt}/3: confirm/unlock on Jade...`);
      const xpub = await runJadeOp(() =>
        withTimeout(jade.getMasterXpub(), 25000, "unlock getMasterXpub()")
      );
      cachedXpub = xpub;
      setMessage("Jade unlocked.");
      return xpub;
    } catch (error) {
      lastError = error;
      setMessage(`Unlock attempt ${attempt}/3 failed. Check Jade screen and PIN entry.`, true);
    }
  }

  throw lastError ?? new Error("Unable to unlock Jade");
}

async function refreshInfo() {
  if (!jade) {
    setMessage("Connect to a Jade first.", true);
    return;
  }
  if (refreshInProgress) {
    setMessage("Refresh already in progress. Complete any prompt on Jade.", true);
    return;
  }

  refreshInProgress = true;
  refreshBtn.disabled = true;
  unlockBtn.disabled = true;
  loadDerivationsBtn.disabled = true;
  connectBtn.disabled = true;

  try {
    setMessage("Refreshing: reading Jade version...");
    const version = await runJadeOp(() =>
      withTimeout(jade.getVersion(), 12000, "getVersion()")
    );
    renderVersionDetails(version);

    setMessage("Refreshing: ensuring Jade is unlocked...");
    const xpub = cachedXpub ?? await ensureJadeUnlocked();
    const xpubString = xpub?.toString ? xpub.toString() : stringify(xpub);
    masterXpub.textContent = xpubString;
    xpubFingerprint.textContent = xpub?.fingerprint ? xpub.fingerprint() : "-";

    setMessage("Refreshing: reading registered multisigs...");
    const multisigs = await runJadeOp(() =>
      withTimeout(jade.getRegisteredMultisigs(), 12000, "getRegisteredMultisigs()")
    );
    multisigCount.textContent = String(getMultisigCount(multisigs));
    masterBlindingKey.textContent = cachedMasterBlindingKey;

    setMessage(`Jade info updated for ${getNetworkLabel()}.`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    setMessage(`Unable to read Jade info: ${reason}. If blocked, unlock Jade and retry refresh.`, true);
  } finally {
    refreshInProgress = false;
    connectBtn.disabled = false;
    unlockBtn.disabled = !jade;
    refreshBtn.disabled = !jade;
    loadDerivationsBtn.disabled = !jade;
  }
}

function getActiveDerivationFormat() {
  const activeButton = document.querySelector("button[data-derivation-tab-target].active");
  if (!activeButton) return null;
  const panelId = activeButton.getAttribute("data-derivation-tab-target");
  if (!panelId) return null;
  return derivationFormatByPanel.get(panelId) ?? null;
}

async function loadDerivationForSelectedTab() {
  if (!jade) {
    setDerivationStatus("Connect to a Jade first.", true);
    return;
  }
  if (derivationInProgress) {
    setDerivationStatus("Derivation already in progress.", true);
    return;
  }

  derivationInProgress = true;
  loadDerivationsBtn.disabled = true;
  connectBtn.disabled = true;
  unlockBtn.disabled = true;
  refreshBtn.disabled = true;

  try {
    await ensureJadeUnlocked();
    const format = getActiveDerivationFormat();
    if (!format) throw new Error("No active derivation tab selected");

    const index = Number(derivationIndexInput.value);
    const chain = Number(derivationChainSelect.value);
    if (!Number.isInteger(index) || index < 0) throw new Error("Index must be a non-negative integer");
    if (!(chain === 0 || chain === 1)) throw new Error("Type must be Address or Change");

    setDerivationStatus(`Deriving ${format.label} ${chain === 0 ? "address" : "change"} index ${index} on ${getNetworkLabel()}...`);
    const path = derivationPath(format.purpose, chain, index);
    const variant = Singlesig.from(format.variant);
    const address = await withTimeout(
      runJadeOp(() => jade.getReceiveAddressSingle(variant, path)),
      12000,
      `${format.key} ${chain}/${index}`
    );

    let shownAddress = String(address);
    if (!derivationConfidential.checked) {
      const parsed = Address.parse(shownAddress, currentNetwork);
      shownAddress = parsed.toUnconfidential().toString();
    }

    const pathEl = document.getElementById(`${format.key}-path`);
    const addressEl = document.getElementById(`${format.key}-address`);
    const qrEl = document.getElementById(`${format.key}-qr`);

    if (pathEl) pathEl.textContent = pathToString(path);
    if (addressEl) addressEl.textContent = shownAddress;
    if (qrEl) {
      const qrText = `${getUriScheme()}:${shownAddress}`;
      qrEl.src = `https://quickchart.io/qr?size=280&text=${encodeURIComponent(qrText)}`;
      qrEl.hidden = false;
    }

    setDerivationStatus("Derivation complete for selected tab.");
  } catch (error) {
    setDerivationStatus(`Derivation failed: ${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    derivationInProgress = false;
    connectBtn.disabled = false;
    unlockBtn.disabled = !jade;
    refreshBtn.disabled = !jade;
    loadDerivationsBtn.disabled = !jade;
  }
}

async function loadDescriptorsOnTabOpen() {
  if (!jade) {
    setDescriptorStatus(`Connect and unlock Jade to compute ${getNetworkLabel()} descriptors.`);
    return;
  }
  if (descriptorsInProgress) return;

  descriptorsInProgress = true;
  try {
    setDescriptorStatus(`Computing ${getNetworkLabel()} descriptors from Jade (unlock/confirm on device if prompted)...`);
    await ensureJadeUnlocked();

    const getDescriptorWithRetry = async (methodName, label) => {
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          setDescriptorStatus(`${label}: attempt ${attempt}/3 (check Jade screen)...`);
          return await runJadeOp(() =>
            withTimeout(jade[methodName](), 30000, label)
          );
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError ?? new Error(`${label} failed`);
    };

    const bip49DescObj = await getDescriptorWithRetry("shWpkh", "bip49 descriptor");
    const bip84DescObj = await getDescriptorWithRetry("wpkh", "bip84 descriptor");

    const bip49Desc = bip49DescObj?.toString ? bip49DescObj.toString() : String(bip49DescObj);
    const bip84Desc = bip84DescObj?.toString ? bip84DescObj.toString() : String(bip84DescObj);
    bip49GlobalDescriptor.value = bip49Desc;
    bip84GlobalDescriptor.value = bip84Desc;

    cachedMasterBlindingKey = extractSlip77FromDescriptor(bip49Desc);
    masterBlindingKey.textContent = cachedMasterBlindingKey;

    setDescriptorStatus(`Descriptors updated for ${getNetworkLabel()}.`);
  } catch (error) {
    setDescriptorStatus(`Unable to compute descriptors: ${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    descriptorsInProgress = false;
  }
}

async function connectJade() {
  if (!navigator.serial) {
    setMessage("This browser does not support Web Serial. Use Chrome/Edge desktop.", true);
    return;
  }

  try {
    connectBtn.disabled = true;
    setMessage(`Choose your Jade in the browser serial picker for ${getNetworkLabel()}, then unlock it on-device.`);

    const createJadeWithRecovery = async () => {
      let lastError = null;
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        try {
          await closeOpenSerialPorts();
          if (attempt > 1) await sleep(150 * attempt);
          return await Promise.resolve(new Jade(currentNetwork, true));
        } catch (error) {
          lastError = error;
          const msg = error instanceof Error ? error.message : String(error);
          if (!msg.toLowerCase().includes("already open")) throw error;
        }
      }
      throw lastError ?? new Error("Unable to open Jade serial port");
    };

    jade = await createJadeWithRecovery();
    cachedXpub = null;
    setConnected(true);

    await refreshInfo();
    await loadDescriptorsOnTabOpen();
  } catch (error) {
    jade = null;
    cachedXpub = null;
    setConnected(false);
    setMessage(`Connection failed: ${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    connectBtn.disabled = false;
  }
}

async function disconnectJade(reason = "Disconnected from Jade.") {
  if (disconnectInProgress) return;
  disconnectInProgress = true;
  connectBtn.disabled = true;
  setMessage("Disconnecting Jade...");
  await waitForNoActiveJadeOps(10000);
  try {
    if (jade && typeof jade.free === "function") jade.free();
  } catch {
    // Ignore disposal errors; we still force UI/state reset.
  }
  try {
    await sleep(250);
    await closeOpenSerialPorts();
    await sleep(200);
    await closeOpenSerialPorts();
  } catch {
    // Ignore serial close failures and continue local reset.
  } finally {
    jade = null;
    cachedXpub = null;
    refreshInProgress = false;
    derivationInProgress = false;
    descriptorsInProgress = false;
    setConnected(false);
    clearDeviceInfo();
    setMessage(reason);
    connectBtn.disabled = false;
    disconnectInProgress = false;
  }
}

async function applyNetworkSelection(nextType, announce = true) {
  if (nextType !== "mainnet" && nextType !== "testnet") return;
  if (nextType === currentNetworkType) {
    setSelectedNetworkLabel();
    return;
  }

  if (jade) {
    await disconnectJade(`Switched to ${getNetworkLabel(nextType)}. Jade disconnected.`);
  }

  currentNetworkType = nextType;
  currentNetwork = nextType === "testnet" ? Network.testnet() : Network.mainnet();
  clearDeviceInfo();

  if (announce) {
    setMessage(`Network set to ${getNetworkLabel()}. Connect Jade to continue.`);
  }
}

connectBtn.addEventListener("click", async () => {
  if (jade) {
    await disconnectJade("Jade disconnected.");
    return;
  }
  await connectJade();
});

unlockBtn.addEventListener("click", async () => {
  if (!jade) {
    setMessage("Connect to a Jade first.", true);
    return;
  }

  try {
    unlockBtn.disabled = true;
    connectBtn.disabled = true;
    refreshBtn.disabled = true;
    loadDerivationsBtn.disabled = true;
    await ensureJadeUnlocked();
  } catch (error) {
    setMessage(`Unlock failed: ${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    connectBtn.disabled = false;
    unlockBtn.disabled = !jade;
    refreshBtn.disabled = !jade;
    loadDerivationsBtn.disabled = !jade;
  }
});

refreshBtn.addEventListener("click", refreshInfo);
loadDerivationsBtn.addEventListener("click", loadDerivationForSelectedTab);
networkSelect.addEventListener("change", () => {
  applyNetworkSelection(networkSelect.value, true);
});

if (navigator.serial && typeof navigator.serial.addEventListener === "function") {
  navigator.serial.addEventListener("disconnect", async () => {
    if (!jade) return;
    await disconnectJade("Jade disconnected from USB.");
  });
}

initTabs("button[data-tab-target]", "data-tab-target", (targetId) => {
  if (targetId === "tab-address-derivation") {
    loadDescriptorsOnTabOpen();
  }
});
initTabs("button[data-derivation-tab-target]", "data-derivation-tab-target");

networkSelect.value = currentNetworkType;
clearDeviceInfo();
setConnected(false);
loadDescriptorsOnTabOpen();
