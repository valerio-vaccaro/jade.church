'use strict';

const $ = (sel) => document.querySelector(sel);
const TEST_MNEMONIC = 'fish inner face ginger orchard permit useful method fence kidney chuckle ' +
  'party favorite sunset draw limb science crane oval letter slot invite sadness banana';

const imagePreview = document.createElement('dialog');
imagePreview.className = 'image-preview';
imagePreview.innerHTML = '<div class="image-preview-head"><span></span><button type="button" aria-label="Close image preview">✕</button></div><img alt="">';
document.body.append(imagePreview);
const imagePreviewImg = imagePreview.querySelector('img');
imagePreview.querySelector('button').onclick = () => imagePreview.close();
imagePreview.addEventListener('click', (e) => {
  if (e.target === imagePreview || e.target === imagePreviewImg) imagePreview.close();
});
document.addEventListener('click', (e) => {
  const link = e.target.closest('.image-preview-link');
  if (!link) return;
  e.preventDefault();
  imagePreview.querySelector('.image-preview-head span').textContent = link.title || link.querySelector('img')?.alt || 'Screenshot';
  imagePreviewImg.src = link.href;
  imagePreviewImg.alt = link.querySelector('img')?.alt || 'Screenshot preview';
  imagePreview.showModal();
});

async function api(path, body, contentType = 'application/json') {
  const opts = body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: contentType === 'application/json' ? JSON.stringify(body) : body,
  };
  const res = await fetch(path, opts);
  const data = res.headers.get('Content-Type')?.includes('json') ? await res.json() : await res.arrayBuffer();
  if (!res.ok) throw Object.assign(new Error(data.error?.message || JSON.stringify(data.error || res.status)), { data });
  return data;
}

// ---------------------------------------------------------------- log panel
const logEl = $('#log');
// Activity log: one line per entry; firmware lines get a class per level.
const LOG_MAX_LINES = 3000;
function log(text, cls = '') {
  const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 4;
  for (const line of String(text).replace(/\n$/, '').split('\n')) {
    const row = document.createElement('div');
    if (cls) row.className = cls;
    row.textContent = line;
    logEl.append(row);
  }
  while (logEl.childElementCount > LOG_MAX_LINES) logEl.firstElementChild.remove();
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}
function fwLog(e) {
  const level = { VERBOSE: 'v', DEBUG: 'd', INFO: 'i', WARN: 'w', ERROR: 'e' }[e.level] || 'o';
  log(e.text, `fw fw-${level}`);
}
$('#log-clear').onclick = () => {
  logEl.textContent = '';
  api('/api/logs/clear', {}).catch(() => {});        // the download starts afresh too
};
$('#log-level').onchange = async (e) => {
  try { await api('/api/loglevel', { level: e.target.value }); }
  catch (err) { log(`[log] ${err.data?.error || err.message}`); }
};

const flowSoundToggle = $('#flow-sound');
flowSoundToggle.checked = localStorage.getItem('flow-completion-sound') !== 'off';
flowSoundToggle.onchange = () => {
  localStorage.setItem('flow-completion-sound', flowSoundToggle.checked ? 'on' : 'off');
  if (flowSoundToggle.checked) primeCompletionSound();
};
let completionAudio = null;
function primeCompletionSound() {
  if (!flowSoundToggle.checked) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx && !completionAudio) completionAudio = new AudioCtx();
    if (completionAudio?.state === 'suspended') completionAudio.resume().catch(() => {});
  } catch { /* audio is optional */ }
}
function playCompletionSound() {
  if (!flowSoundToggle.checked) return;
  primeCompletionSound();
  if (!completionAudio) return;
  try {
    const ctx = completionAudio, start = ctx.currentTime + 0.02;
    [660, 880].forEach((frequency, i) => {
      const at = start + i * 0.15;
      const oscillator = ctx.createOscillator(), gain = ctx.createGain();
      oscillator.type = 'sine'; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.13);
      oscillator.connect(gain); gain.connect(ctx.destination);
      oscillator.start(at); oscillator.stop(at + 0.14);
    });
  } catch { /* audio is optional */ }
}

// ---------------------------------------------------------------- screen
const canvas = $('#screen');
const ctx = canvas.getContext('2d');
let shownSeq = -1, wantedSeq = 0, fetching = false;

function drawRGB565(buf, w, h) {
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
    canvas.style.width = `calc(${w}px * var(--scale, 1.5))`;
    canvas.style.height = `calc(${h}px * var(--scale, 1.5))`;
  }
  const src = new Uint8Array(buf);
  const img = ctx.createImageData(w, h);
  const dst = img.data;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const v = (src[2 * i] << 8) | src[2 * i + 1];   // big-endian RGB565
    const r = (v >> 11) & 0x1f, g = (v >> 5) & 0x3f, b = v & 0x1f;
    dst[j] = (r << 3) | (r >> 2);
    dst[j + 1] = (g << 2) | (g >> 4);
    dst[j + 2] = (b << 3) | (b >> 2);
    dst[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

async function refreshFrame() {
  if (fetching) return;
  fetching = true;
  try {
    while (shownSeq < wantedSeq) {
      const res = await fetch('/api/frame', { cache: 'no-store' });
      if (!res.ok) break;
      const seq = +res.headers.get('X-Frame-Seq');
      drawRGB565(await res.arrayBuffer(), +res.headers.get('X-Width'), +res.headers.get('X-Height'));
      shownSeq = seq;
      if (seq < wantedSeq) continue;
    }
  } catch (e) {
    console.warn('frame fetch failed', e);
  } finally {
    fetching = false;
  }
}

const scaleSel = $('#scale');
scaleSel.value = localStorage.getItem('jw-scale') || '1.5';
if (!scaleSel.value) scaleSel.value = '1.5';
const applyScale = () => {
  document.documentElement.style.setProperty('--scale', scaleSel.value);
  localStorage.setItem('jw-scale', scaleSel.value);
};
scaleSel.onchange = applyScale; applyScale();

// Save the current screen as a PNG, upscaled (nearest-neighbour) to the chosen scale
function saveScreenshot() {
  if (shownSeq < 0) { log('[screenshot] no frame yet'); return; }
  const k = Math.max(1, Math.round(+scaleSel.value));   // whole pixels: 1.5 saves at 2x
  const out = document.createElement('canvas');
  out.width = canvas.width * k; out.height = canvas.height * k;
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = false;
  octx.drawImage(canvas, 0, 0, out.width, out.height);
  out.toBlob((blob) => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `jade-screen-${ts}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    log(`[screenshot] saved ${a.download} (${out.width}x${out.height})`);
  }, 'image/png');
}
$('#screenshot').onclick = () => { saveScreenshot(); device.focus(); };

// ---------------------------------------------------------------- input
const device = $('#device');
const btns = Object.fromEntries([...document.querySelectorAll('.buttons button')].map((b) => [b.dataset.ev, b]));

function sendInput(ev) {
  const b = btns[ev];
  b.classList.add('pressed');
  setTimeout(() => b.classList.remove('pressed'), 120);
  api('/api/input', { event: ev }).catch((e) => log(`[input] ${e.message}`));
}
for (const [ev, b] of Object.entries(btns)) b.onclick = () => { sendInput(ev); device.focus(); };
canvas.onclick = () => device.focus();

const KEYMAP = { ArrowLeft: 'left', ArrowUp: 'left', ArrowRight: 'right', ArrowDown: 'right', Enter: 'click', ' ': 'click' };
device.addEventListener('keydown', (e) => {
  if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault(); saveScreenshot(); return;
  }
  const ev = KEYMAP[e.key];
  if (!ev || e.repeat && ev === 'click') return;
  e.preventDefault();
  sendInput(ev);
});
device.focus();

// ---------------------------------------------------------------- camera
const CAM_W = 320, CAM_H = 240;
const camCanvas = $('#cam-preview');
const camCtx = camCanvas.getContext('2d', { willReadFrequently: true });
const video = $('#cam-video');
let camTimer = null, camStream = null, camBusy = false;

function grabGray(source, sw, sh) {
  // cover-crop the source to 4:3 and draw it at 320x240
  const scale = Math.max(CAM_W / sw, CAM_H / sh);
  const dw = sw * scale, dh = sh * scale;
  camCtx.fillStyle = '#fff';
  camCtx.fillRect(0, 0, CAM_W, CAM_H);
  camCtx.drawImage(source, (CAM_W - dw) / 2, (CAM_H - dh) / 2, dw, dh);
  const rgba = camCtx.getImageData(0, 0, CAM_W, CAM_H).data;
  const gray = new Uint8Array(CAM_W * CAM_H);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    gray[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  // show what the firmware sees
  const out = camCtx.createImageData(CAM_W, CAM_H);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    out.data[j] = out.data[j + 1] = out.data[j + 2] = gray[i]; out.data[j + 3] = 255;
  }
  camCtx.putImageData(out, 0, 0);
  return gray;
}

async function pushFrame(gray) {
  if (camBusy) return;
  camBusy = true;
  try { await api('/api/camera', gray, 'application/octet-stream'); }
  catch (e) { log(`[camera] ${e.message}`); }
  finally { camBusy = false; }
}

function stopCamera() {
  clearInterval(camTimer); camTimer = null;
  camStream?.getTracks().forEach((t) => t.stop()); camStream = null;
  camCanvas.classList.remove('on');
  $('#cam-stop').disabled = true;
  $('#cam-live').classList.remove('active');
}

function startFeed(grab, intervalMs) {
  camCanvas.classList.add('on');
  $('#cam-stop').disabled = false;
  camTimer = setInterval(() => { const g = grab(); if (g) pushFrame(g); }, intervalMs);
}

$('#cam-live').onclick = async () => {
  stopCamera();
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
  } catch (e) { log(`[camera] webcam unavailable: ${e.message}`); return; }
  video.srcObject = camStream;
  await video.play();
  $('#cam-live').classList.add('active');
  startFeed(() => video.videoWidth ? grabGray(video, video.videoWidth, video.videoHeight) : null, 200);
  log('[camera] streaming webcam');
};

function useStaticImage(blob) {
  const img = new Image();
  img.onload = () => {
    stopCamera();
    const gray = grabGray(img, img.naturalWidth, img.naturalHeight);
    URL.revokeObjectURL(img.src);
    // Re-send periodically: the firmware only consumes frames while a scan screen is open
    startFeed(() => gray, 400);
    log(`[camera] feeding static image ${img.naturalWidth}x${img.naturalHeight}`);
  };
  img.src = URL.createObjectURL(blob);
}
$('#cam-file').onchange = (e) => { if (e.target.files[0]) useStaticImage(e.target.files[0]); e.target.value = ''; };
$('#cam-stop').onclick = () => { stopCamera(); log('[camera] stopped'); };
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); useStaticImage(item.getAsFile()); }
});

// ---------------------------------------------------------------- device actions
$('#restart').onclick = async () => {
  if (!confirm('Power-cycle the emulated Jade? Storage is kept, unlocked state is lost.')) return;
  try { await api('/api/restart', {}); } catch (e) { log(`[restart] ${e.message}`); }
};
$('#nvs-save').onclick = async () => {
  try { const r = await api('/api/nvs/save', {}); log(`[nvs] saved to ${r.file}`); }
  catch (e) { log(`[nvs] ${e.message}`); }
};

// ---------------------------------------------------------------- RPC console
const out = $('#rpc-out');
function outLine(text, cls) {
  const span = document.createElement('span');
  span.className = cls; span.textContent = text + '\n';
  out.append(span);
  out.scrollTop = out.scrollHeight;
}

async function runRpc(method, params) {
  outLine(`> ${method} ${params === undefined ? '' : JSON.stringify(params)}`, 'out-req');
  $('#rpc-send').disabled = true;
  try {
    const { trace } = await api('/api/rpc', { method, params });
    for (const step of trace) {
      const r = step.reply;
      if (trace.length > 1) outLine(`  [${step.method}]`, 'out-req');
      if (r.error) outLine(JSON.stringify(r.error, null, 2), 'out-err');
      else outLine(JSON.stringify(r.result, null, 2), 'out-ok');
    }
  } catch (e) {
    outLine(e.message, 'out-err');
  } finally {
    $('#rpc-send').disabled = false;
  }
}

$('#rpc-form').onsubmit = (e) => {
  e.preventDefault();
  const method = $('#rpc-method').value.trim();
  const raw = $('#rpc-params').value.trim();
  let params;
  if (raw) {
    try { params = JSON.parse(raw); } catch (err) { outLine(`bad params JSON: ${err.message}`, 'out-err'); return; }
  }
  runRpc(method, params);
};

const PRESETS = [
  ['version', 'get_version_info'],
  ['ping', 'ping'],
  ['set test mnemonic', 'debug_set_mnemonic', { mnemonic: TEST_MNEMONIC }],
  ['auth (testnet)', 'auth_user', { network: 'testnet', epoch: 0 }],
  ['xpub m/84\'/1\'/0\'', 'get_xpub', { network: 'testnet', path: [0x80000054, 0x80000001, 0x80000000] }],
  ['address', 'get_receive_address', { network: 'testnet', path: [0x80000054, 0x80000001, 0x80000000, 0, 0], variant: 'wpkh(k)' }],
  ['sign msg', 'sign_message', { path: [0x80000054, 0x80000001, 0x80000000, 0, 0], message: 'hello from jade.church' }],
  ['logout', 'logout'],
];
for (const [label, method, params] of PRESETS) {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = label;
  b.title = params ? `${method} ${JSON.stringify(params)}` : method;
  b.onclick = () => {
    $('#rpc-method').value = method;
    $('#rpc-params').value = params ? JSON.stringify(params, null, 1) : '';
    runRpc(method, params);
  };
  $('#presets').append(b);
}

// ---------------------------------------------------------------- info + events
async function loadInfo() {
  const info = await api('/api/info');
  $('#app-version').textContent = `version ${info.version || '?'}`;
  $('#app-version').title = 'Exact tag or commit ID of this checkout';
  const firmwareName = info.firmware?.file || info.lib || 'unknown firmware';
  const firmwareLabel = $('#firmware-name-label');
  firmwareLabel.textContent = firmwareName;
  firmwareLabel.title = `Running firmware ${firmwareName}`;
  if (info.bridge) {
    const dev = `tcp:${info.bridge.host}:${info.bridge.port}`;
    $('#bridge').innerHTML = `
      <p class="muted">Standard Jade CBOR-RPC over TCP, driving this same emulated device.
      Connect any jadepy-based client to <code>${dev}</code></p>
      <pre>from jadepy import JadeAPI
jade = JadeAPI.create_serial('${dev}', timeout=120)
jade.connect()
print(jade.get_version_info())</pre>`;
  } else {
    $('#bridge').innerHTML = '<p class="muted">Bridge disabled (started with --bridge-port -1).</p>';
  }

  const b = info.build || {};
  const fw = info.firmware || {};
  const lvl = $('#log-level');
  lvl.value = info.log_level;
  const noLog = fw.options && fw.options.log === false;
  lvl.disabled = !!noLog;
  lvl.title = noLog ? 'This firmware was built without logging (--no-log)' : 'Firmware log level (changed live)';
  const rows = [
    ['Jade source', info.jade_version || '?'],
    ['Build', [b.CMAKE_BUILD_TYPE, b.CI && b.CI !== '0' ? 'CI (auto-confirm)' : 'interactive',
               b.LOG && b.LOG !== '0' && b.LOG !== 'OFF' ? 'logging' : null,
               b.CAMERA && b.CAMERA !== '0' ? 'camera' : null].filter(Boolean).join(' · ') || '?'],
    ['Board', fw.board ? `${fw.board === 'jade-v1' ? 'Jade v1' : fw.board === 'jade-v2' ? 'Jade v2' : fw.board}` +
      ` · ${info.width}×${info.height}` : `${info.width}×${info.height}` + (b.JADE_DISPLAY ? ` (${b.JADE_DISPLAY})` : '')],
    ['Firmware', fw.file ? `${fw.file}` + (fw.built ? ` (built ${fw.built.slice(0, 16).replace('T', ' ')})` : '') : info.lib],
    ['Web UI', `http://${info.web}/`],
    ['CBOR-RPC port', info.bridge ? `tcp:${info.bridge.host}:${info.bridge.port}` : 'disabled'],
    ['Storage (NVS)', info.nvs_file || 'not persisted'],
    ['Run history', info.runs_dir],
    ['Test pinserver', info.test_pinserver || 'not started (see --test-pinserver-port)'],
    ['Firmware log level', `${info.log_level} (shown in the Activity box and the server terminal)`],
  ];
  const dl = $('#config-info');
  dl.textContent = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  }
}

let lastEventT = 0;
function connectEvents() {
  const pill = $('#conn');
  const es = new EventSource('/api/events');
  es.onopen = () => { shownSeq = -1; wantedSeq = 0; pill.textContent = 'libjade running'; pill.className = 'pill ok'; loadInfo().catch(() => {}); loadStatus(); };
  es.onerror = () => { pill.textContent = 'disconnected'; pill.className = 'pill bad'; };
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    // the server replays recent events on (re)connect: skip ones already shown
    if (e.type !== 'frame') { if (e.t <= lastEventT) return; lastEventT = e.t; }
    if (e.type === 'frame') { wantedSeq = Math.max(wantedSeq, e.seq); refreshFrame(); }
    else if (e.type === 'flow') { onFlowEvent(e); onStatusEvent(e); if (e.event === 'start' || e.event === 'end') runsChanged(); }
    else if (e.type === 'suite') { onSuiteEvent(e); onStatusEvent(e); runsChanged(); }
    else if (e.type === 'runs') runsChanged();
    else if (e.type === 'log') log(e.text.trimEnd());
    else if (e.type === 'fwlog') fwLog(e);
    else if (e.type === 'firmware') { log(`[firmware] now running ${e.label}`); loadInfo().catch(() => {}); loadFirmware(); }
    else if (e.type === 'activity') log(`[${new Date(e.t * 1000).toLocaleTimeString()}] ${e.text}`);
  };
}
connectEvents();

// ---------------------------------------------------------------- firmware selection (Device box)
async function loadFirmware() {
  const sel = $('#fw-select');
  let data;
  try { data = await api('/api/firmware'); } catch { return; }
  sel.textContent = '';
  for (const f of data.items) {
    const o = new Option(f.label + (f.file === data.default ? ' (default)' : ''), f.file);
    o.title = f.file + (f.built ? ` — built ${f.built.slice(0, 16).replace('T', ' ')}` : '');
    if (f.active) o.selected = true;
    sel.append(o);
  }
  if (!data.items.some((f) => f.active)) sel.prepend(new Option(`${data.active} (not in firmware/)`, '', true, true));
  sel.disabled = data.items.length < 2 && data.items.some((f) => f.active);
  sel.dataset.active = data.active;
}
$('#fw-select').onchange = async (e) => {
  const sel = e.target, file = sel.value;
  if (!file) return;
  sel.disabled = true;
  log(`[firmware] switching to ${sel.selectedOptions[0].textContent} …`);
  try {
    await api('/api/firmware', { file });          // the 'firmware' event refreshes the rest
  } catch (err) {
    log(`[firmware] ${err.data?.error || err.message}`);
    sel.value = sel.dataset.active;
  } finally {
    sel.disabled = false;
  }
};
loadFirmware();

// ---------------------------------------------------------------- run status (Activity box)
// What is running: the flow with its step progress, and a suite with its queue.
// Loaded from /api/status (also after a reconnect), then kept live from the events.
const runStatus = { flow: null, suite: null };
let lastRunSummary = { status: 'idle', text: 'Idle' };
let pendingRunRequest = false;
let runsBusy = false;
function pipelineOccupied() { return !!(runStatus.flow || runStatus.suite || pendingRunRequest); }

async function loadStatus() {
  try {
    const st = await api('/api/status');
    runStatus.flow = st.flow && { ...st.flow, failed: st.flow.failed_steps, paused: st.flow.paused_line,
                                  suite: st.flow.in_suite };
    runStatus.suite = st.suite;
    renderStatus();
    // a page opened (or reconnected) mid-run: reflect it in the Flow tab's buttons
    if (st.flow && !st.suite) {
      pausedLine = st.flow.paused_line ?? null;
      if (pausedLine != null) setFlowStatus('paused', `paused at line ${pausedLine}`);
      else setFlowStatus('running', `running ${st.flow.name}`);
    } else if (st.suite) {
      setFlowStatus('running', `suite ${st.suite.index}/${st.suite.total}`);
    } else if (pausedLine != null || flowStatus.classList.contains('running')) {
      pausedLine = null;
      setFlowStatus(null, '');
    }
  } catch { /* the server may be restarting */ }
}

function onStatusEvent(e) {
  if (e.t < PAGE_LOADED_T) return;                   // replayed history: /api/status covers it
  if (e.type === 'suite') {
    if (e.event === 'start') {
      runStatus.suite = { name: e.name, total: e.total, index: 0, passed: 0, failed: 0,
                          cancelled: 0, started: e.t };
    } else if (e.event === 'end') runStatus.suite = null;
  } else if (e.event === 'start') {
    runStatus.flow = { name: e.name, file: e.file, started: e.started || e.t, steps_done: 0,
                       steps_total: e.steps_total || e.steps, failed: 0, suite: !!e.suite };
    if (e.suite && runStatus.suite) runStatus.suite.index = e.suite.index;
  } else if (e.event === 'paused' && runStatus.flow) {
    runStatus.flow.paused = e.line;
  } else if (e.event === 'step' && e.status === 'running' && runStatus.flow) {
    runStatus.flow.paused = null;
  } else if (e.event === 'step' && e.status !== 'running' && runStatus.flow) {
    runStatus.flow.steps_done++;
    if (e.status === 'failed' || e.status === 'stopped') runStatus.flow.failed++;
  } else if (e.event === 'end') {
    const inSuite = runStatus.flow?.suite;
    runStatus.flow = null;
    if (inSuite && runStatus.suite && e.status !== 'cancelled') {
      runStatus.suite[e.status === 'passed' ? 'passed' : 'failed']++;
    }
  }
  renderStatus();
}

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function renderStatus() {
  const { flow, suite } = runStatus;
  const now = Date.now() / 1000;
  const box = $('#run-status');
  const parts = [];
  if (suite) {
    const queued = Math.max(0, suite.total - Math.max(suite.index, 1));
    parts.push(`Suite “${suite.name}”: flow ${suite.index || '–'} of ${suite.total} · ${queued} queued · ` +
      `${suite.passed} passed` + (suite.failed ? `, ${suite.failed} failed` : '') +
      ` · ${fmtDuration(now - suite.started)}`);
  }
  if (flow) {
    const total = Math.max(flow.steps_total || 0, flow.steps_done);
    parts.push(`Running ${flow.file || flow.name} — step ${Math.min(flow.steps_done + 1, total || 1)} of ${total}` +
      (flow.failed ? ` · ${flow.failed} failed step(s)` : '') +
      (flow.paused != null ? ` · ⏸ paused at line ${flow.paused}` : '') + ` · ${fmtDuration(now - flow.started)}`);
  }
  const busy = !!(flow || suite);
  box.className = `run-status ${busy ? 'busy' : 'idle'}` + (suite?.failed || flow?.failed ? ' has-failures' : '');
  $('#run-status-text').textContent = busy ? parts.join('\n') : 'Idle: no flow running, nothing queued';
  $('#run-status-stop').hidden = !busy;

  $('#flow-run').disabled = pipelineOccupied();
  $('#suite-run').disabled = pipelineOccupied();
  const paused = !!flow && flow.paused != null;
  $('#flow-step').disabled = !!suite || (!!flow && !paused) || pendingRunRequest;
  $('#flow-continue').disabled = !!suite || !paused || pendingRunRequest;
  document.querySelectorAll('#runs-list .rerun').forEach((button) => {
    if (button.dataset.running !== 'true') button.disabled = pipelineOccupied() || runsBusy;
  });

  const top = $('#top-run-status');
  let summary = lastRunSummary;
  if (suite) {
    summary = { status: 'running', text: `${suite.name}: ${suite.passed} passed${suite.failed ? ` · ${suite.failed} failed` : ''} · ${suite.index}/${suite.total}` };
  } else if (flow) {
    const total = Math.max(flow.steps_total || 0, flow.steps_done || 0);
    summary = { status: 'running', text: `${flow.file || flow.name}: step ${Math.min(flow.steps_done + 1, total || 1)}/${total || '?'}` };
  }
  top.textContent = summary.text;
  top.className = `pill run-summary ${summary.status}`;
  top.title = summary.text;
}
renderStatus();
setInterval(() => { if (runStatus.flow || runStatus.suite) renderStatus(); }, 1000);
$('#run-status-stop').onclick = () => api('/api/flow/stop', {}).catch((e) => log(`[flow] ${e.message}`));

// ---------------------------------------------------------------- flows
const PAGE_LOADED_T = Date.now() / 1000;
const flowSrc = $('#flow-src'), gutter = $('#flow-gutter'), curLine = $('#flow-curline');
const flowOut = $('#flow-out'), flowStatus = $('#flow-status');
const LINE_H = 19, PAD_TOP = 8;
let lineMarks = {};          // line -> running|passed|failed|error
let myRun = null;            // id of the run started from this page
let runRequested = false;    // our POST is in flight (its events may arrive first)
let flowTimeoutTimer = null, flowTimeoutRow = null, flowTimeoutDeadline = 0;
let activeRow = null;        // output row of the step being executed
let markLine = null, markFailed = false;

const DEFAULT_FLOW = `# Maestro-style flow: steps run top to bottom. Click "syntax" for the full list.
name: my-first-flow
---
- screenshot: home
- right
- screenshot: next-page
- left
- exec: {method: get_version_info, as: info}
- log: "state: \${info.JADE_STATE}"
- expect: {var: info.JADE_FEATURES, contains: DEV}
`;

// ---- editor tabs: several flows open at once; Run / Step act on the selected tab.
// The page starts with no flow open. Each tab keeps its text, its file name and its own
// gutter marks; the run's marks go to the tab it was started from, even if you switch away.
let flowTabs = [], activeTab = null, runTab = null, tabSeq = 0;
let pausedLine = null;       // step mode: the line the run is paused at
const BLANK_FLOW = 'name: untitled\n---\n';

function makeTab(text, file = null) {
  return { id: ++tabSeq, text, file, orig: file ? text : null,
           marks: {}, markLine: null, markFailed: false, scroll: 0, sel: 0 };
}
localStorage.removeItem('jw-flow-tabs');      // earlier versions restored the open tabs
localStorage.removeItem('jw-flow');
flowSrc.value = '';

// No tab open: show a hint instead of the editor, and disable what needs a flow
function updateFlowEmpty() {
  const none = !activeTab;
  $('#flow-empty').hidden = !none;
  $('#flow-editor').hidden = none;
  $('#flow-lint').hidden = none;
  const idle = $('#flow-stop').disabled;
  $('#flow-run').disabled = none || !idle;
  $('#flow-step').disabled = (none && idle) || (!idle && pausedLine == null);
  $('#flow-check').disabled = none;
  $('#flow-save').disabled = none;
}

function tabLabel(t) {
  if (t.file) return t.file.split('/').pop();
  const m = t.text.match(/^name:\s*["']?([^"'\n#]+)/m);
  return m ? m[1].trim() : 'untitled';
}
const tabModified = (t) => t.orig != null && t.text !== t.orig;
const tabIsBlank = (t) => !t.file && (!t.text.trim() || t.text === DEFAULT_FLOW || t.text === BLANK_FLOW);

function renderFlowTabs() {
  const bar = $('#flow-tabs');
  bar.textContent = '';
  const busy = $('#flow-stop') && !$('#flow-stop').disabled;
  for (const t of flowTabs) {
    const b = el('div', `flow-tab${t === activeTab ? ' active' : ''}${t === runTab && busy ? ' running' : ''}`);
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', t === activeTab);
    b.tabIndex = t === activeTab ? 0 : -1;
    b.title = (t.file || tabLabel(t)) + (tabModified(t) ? ' (modified)' : '') + (t === runTab && busy ? ' — running' : '');
    if (t === runTab && busy) b.append(el('span', 'ft-run', pausedLine != null ? '⏸' : '▶'));
    b.append(el('span', 'ft-name', tabLabel(t) + (tabModified(t) ? ' •' : '')));
    const x = el('button', 'ft-close', '×');
    x.type = 'button'; x.title = 'Close'; x.setAttribute('aria-label', `Close ${tabLabel(t)}`);
    x.onclick = (e) => { e.stopPropagation(); closeFlowTab(t); };
    b.append(x);
    b.onclick = () => selectFlowTab(t);
    b.onauxclick = (e) => { if (e.button === 1) closeFlowTab(t); };
    b.onkeydown = (e) => {
      const i = flowTabs.indexOf(t);
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const n = flowTabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + flowTabs.length) % flowTabs.length];
        selectFlowTab(n); $('#flow-tabs .flow-tab.active')?.focus();
      } else if (e.key === 'Delete') closeFlowTab(t);
    };
    bar.append(b);
  }
  bar.hidden = !flowTabs.length;
  updateFlowEmpty();
}

function selectFlowTab(t) {
  if (t === activeTab) return;
  if (activeTab) {
    Object.assign(activeTab, { marks: lineMarks, markLine, markFailed, scroll: flowSrc.scrollTop,
                               sel: flowSrc.selectionStart });
  }
  activeTab = t;
  flowSrc.value = t.text;
  lineMarks = t.marks; markLine = t.markLine; markFailed = t.markFailed;
  renderGutter();
  highlightFlow();
  flowSrc.scrollTop = t.scroll;
  flowSrc.setSelectionRange(t.sel, t.sel);
  gutter.scrollTop = flowSrc.scrollTop; syncHl(); placeCurLine();
  sug = null; renderSuggest();
  scheduleLint();
  renderFlowTabs();
}

function closeFlowTab(t) {
  if (t === runTab && !$('#flow-stop').disabled) { log('[flow] stop the running flow before closing its tab'); return; }
  const unsaved = tabModified(t) || (!t.file && !tabIsBlank(t));
  if (unsaved && !confirm(`Close "${tabLabel(t)}"? Its changes are not saved to a file.`)) return;
  const i = flowTabs.indexOf(t);
  flowTabs.splice(i, 1);
  if (t === runTab) runTab = null;
  if (t === activeTab) {
    activeTab = null;
    if (flowTabs.length) {
      selectFlowTab(flowTabs[Math.min(i, flowTabs.length - 1)]);
    } else {                                       // last one closed: back to "no flow open"
      flowSrc.value = ''; lineMarks = {}; markLine = null;
      renderGutter(); highlightFlow();
      $('#flow-lint').textContent = '';
    }
  }
  renderFlowTabs();
}

// Open text in a tab: switch to the tab already holding that file, reuse a blank
// selected tab, or add a new one (always, with `fresh`).
function openInTab(text, file = null, fresh = false) {
  const existing = file && flowTabs.find((t) => t.file === file);
  if (existing && !fresh) {
    if (!tabModified(existing)) { existing.text = text; existing.orig = text; }
    if (existing === activeTab) { flowSrc.value = existing.text; highlightFlow(); renderGutter(); }
    selectFlowTab(existing);
    renderFlowTabs();
    return existing;
  }
  let t;
  if (!fresh && activeTab && tabIsBlank(activeTab) && activeTab !== runTab) {
    t = activeTab;
    Object.assign(t, makeTab(text, file), { id: t.id });
    flowSrc.value = text;
    lineMarks = {}; markLine = null;
    renderGutter(); highlightFlow(); scheduleLint();
  } else {
    t = makeTab(text, file);
    flowTabs.push(t);
    selectFlowTab(t);
  }
  renderFlowTabs();
  return t;
}

function renderGutter() {
  const n = flowSrc.value.split('\n').length;
  let html = '';
  for (let i = 1; i <= n; i++) html += `<div class="${lineMarks[i] || ''}">${i}</div>`;
  gutter.innerHTML = html;
  gutter.scrollTop = flowSrc.scrollTop;
  placeCurLine();
}
function placeCurLine() {
  if (markLine == null) { curLine.hidden = true; return; }
  curLine.hidden = false;
  curLine.classList.toggle('failed', markFailed);
  curLine.style.top = `${PAD_TOP + (markLine - 1) * LINE_H - flowSrc.scrollTop}px`;
}
function setMark(line, status, tab = runTab || activeTab) {
  if (!tab) return;
  const prev = tab === activeTab ? lineMarks[line] : tab.marks[line];
  if (status === 'passed' && prev === 'fwerror') return;     // keep the warning visible
  if (status === 'fwerror' && (prev === 'failed' || prev === 'error')) return;
  if (tab !== activeTab) {                         // the run's tab is in the background
    tab.marks[line] = status;
    if (status === 'running' || status === 'paused' || status === 'failed' || status === 'error') {
      tab.markLine = line; tab.markFailed = status === 'failed' || status === 'error';
    }
    return;
  }
  lineMarks[line] = status;
  const el = gutter.children[line - 1];
  if (el) el.className = status;
  if (status === 'running' || status === 'paused' || status === 'failed' || status === 'error') {
    markLine = line; markFailed = status === 'failed' || status === 'error';
    curLine.classList.toggle('paused', status === 'paused');
    scrollToLine(line, false);
    placeCurLine();
  }
}
function clearMarks() { lineMarks = {}; markLine = null; renderGutter(); }
function scrollToLine(line, select) {
  const top = PAD_TOP + (line - 1) * LINE_H;
  if (top < flowSrc.scrollTop || top > flowSrc.scrollTop + flowSrc.clientHeight - 2 * LINE_H) {
    flowSrc.scrollTop = Math.max(0, top - flowSrc.clientHeight / 3);
  }
  if (select) {
    const lines = flowSrc.value.split('\n');
    const start = lines.slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0);
    flowSrc.focus();
    flowSrc.setSelectionRange(start, start + lines[line - 1].length);
  }
}

flowSrc.addEventListener('input', () => {
  if (!activeTab) return;
  const wasModified = tabModified(activeTab), wasLabel = tabLabel(activeTab);
  activeTab.text = flowSrc.value;
  if (tabModified(activeTab) !== wasModified || tabLabel(activeTab) !== wasLabel) renderFlowTabs();
  if (Object.keys(lineMarks).length || markLine != null) clearMarks(); else renderGutter();
});
flowSrc.addEventListener('scroll', () => { gutter.scrollTop = flowSrc.scrollTop; placeCurLine(); });
flowSrc.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    flowSrc.setRangeText('  ', flowSrc.selectionStart, flowSrc.selectionEnd, 'end');
    flowSrc.dispatchEvent(new Event('input'));
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault(); runFlow();
  } else if (e.key === 'F10') {
    e.preventDefault(); stepFlow();
  } else if (e.key === 'F8') {
    e.preventDefault(); continueFlow();
  }
});
renderGutter();
renderFlowTabs();

function setFlowStatus(status, text) {
  flowStatus.className = `flow-status ${status || ''}`;
  flowStatus.textContent = text ?? status ?? '';
  const running = status === 'running' || status === 'paused';
  $('#flow-run').disabled = running || pipelineOccupied();
  $('#flow-stop').disabled = !running;
  $('#flow-step').disabled = running && status !== 'paused';
  $('#flow-continue').disabled = status !== 'paused';
  renderFlowTabs();
}

function outRow(cls, line, text, detail) {
  const row = document.createElement('div');
  row.className = `st ${cls}` + (/^expect\b/.test(text || '') ? ' expect' : '');
  row.innerHTML = '<span class="ic"></span><span class="ln"></span><span class="tx"></span>';
  row.querySelector('.ic').textContent = { running: '▶', passed: '✓', failed: '✗', stopped: '■', cancelled: '⊘' }[cls] || '·';
  row.querySelector('.ln').textContent = line ?? '';
  const tx = row.querySelector('.tx');
  tx.textContent = text;
  if (detail) { const d = document.createElement('span'); d.className = 'dt'; d.textContent = `  → ${detail}`; tx.append(d); }
  if (line) row.onclick = () => scrollToLine(line, true);
  flowOut.append(row);
  flowOut.scrollTop = flowOut.scrollHeight;
  return row;
}

const suiteRuns = new Set();   // run ids that belong to a suite: compact output

function stopFlowTimeout() {
  clearInterval(flowTimeoutTimer);
  flowTimeoutTimer = null;
  flowTimeoutRow = null;
}

function startFlowTimeout(seconds) {
  stopFlowTimeout();
  flowTimeoutDeadline = Date.now() + Math.max(1, Number(seconds) || 600) * 1000;
  flowTimeoutRow = document.createElement('div');
  flowTimeoutRow.className = 'flow-timeout';
  flowOut.append(flowTimeoutRow);
  const update = () => {
    const left = Math.max(0, Math.ceil((flowTimeoutDeadline - Date.now()) / 1000));
    flowTimeoutRow.textContent = left
      ? `Timeout in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
      : 'Timeout reached — stopping flow…';
  };
  update();
  flowTimeoutTimer = setInterval(update, 1000);
}

function onFlowEvent(e) {
  if (e.t < PAGE_LOADED_T) return;   // history from before this page was opened
  if (e.event === 'end') stopFlowTimeout();
  if (e.event === 'start' && e.suite) suiteRuns.add(e.run);
  if (suiteRuns.has(e.run)) {
    onSuiteFlowEvent(e);
    if (e.event === 'start') startFlowTimeout(e.timeout);
    return;
  }
  if (e.event === 'end') {
    playCompletionSound();
    const name = runStatus.flow?.file || runStatus.flow?.name || e.dir;
    lastRunSummary = { status: e.status, text: `Flow ${e.status}: ${name}` };
  }
  if (e.event === 'start' && runRequested && myRun == null) myRun = e.run;
  const mine = e.run === myRun;
  if (e.event === 'paused') {
    pausedLine = e.line;
    if (mine) setMark(e.line, 'paused');
    setFlowStatus('paused', `paused at line ${e.line}`);
    return;
  }
  if (e.event === 'start') {
    pausedLine = null;
    if (!mine) {
      runTab = null;
      flowOut.textContent = '';
      outRow('', null, e.rerun_of ? `running "${e.file || e.name}" again (from the Results tab)`
        : `flow "${e.name}" started elsewhere (eg. scripts/run_flow.py)`);
    }
    setFlowStatus('running', `running ${e.name}`);
    startFlowTimeout(e.timeout);
  } else if (e.event === 'step') {
    if (e.status === 'running') {
      if (pausedLine != null) { pausedLine = null; setFlowStatus('running', `running ${e.text}`.slice(0, 60)); }
      activeRow = outRow('running', e.line, e.text);
    } else {
      const row = outRow(e.status, e.line, e.text, e.detail);
      if (activeRow) { activeRow.replaceWith(row); activeRow = null; }
      flowOut.scrollTop = flowOut.scrollHeight;
    }
    if (mine) setMark(e.line, e.status);
  } else if (e.event === 'screenshot') {
    const box = document.createElement('div');
    box.className = 'shots';
    box.innerHTML = `<a class="image-preview-link" href="/screenshots/${encodeURI(e.path)}" title="${e.path}">` +
      `<img src="/screenshots/${encodeURI(e.path)}" alt="screenshot ${e.path}"></a>`;
    (activeRow ? activeRow.after(box) : flowOut.append(box));
  } else if (e.event === 'fwerror') {
    const row = outRow('fwerror', e.line, `⚠ firmware error: ${e.text}`);
    (activeRow ? activeRow.after(row) : flowOut.append(row));
    if (mine && e.line) setMark(e.line, 'fwerror');
  } else if (e.event === 'end') {
    activeRow = null;
    const end = document.createElement('div');
    end.className = `end ${e.status}`;
    end.textContent = `${e.status} in ${e.seconds}s` + (e.error ? ` — ${e.error}` : '') +
      (e.firmware_errors ? ` · ⚠ ${e.firmware_errors} firmware error(s)` : '') +
      (e.screenshots?.length ? ` · ${e.screenshots.length} screenshot(s) in data/screenshots/` : '');
    flowOut.append(end);
    flowOut.scrollTop = flowOut.scrollHeight;
    pausedLine = null;
    setFlowStatus(e.status);
    if (mine && e.status === 'passed') {
      if (runTab && runTab !== activeTab) runTab.markLine = null; else { markLine = null; placeCurLine(); }
    }
  }
}

async function runFlow(step = false) {
  if (!activeTab || pipelineOccupied()) return;
  pendingRunRequest = true;
  renderStatus();
  primeCompletionSound();
  clearMarks();
  flowOut.textContent = '';
  myRun = null;
  runRequested = true;
  runTab = activeTab;
  try {
    const r = await api('/api/flow/run', { source: flowSrc.value, step });
    if (step) outRow('', null, 'step mode: paused before each step — Step (F10) runs the highlighted one, Continue (F8) the rest');
    myRun = r.id;
  } catch (err) {
    const d = err.data || {};
    if (d.line) setMark(d.line, 'error');
    outRow('failed', d.line, d.error || err.message);
    setFlowStatus('failed', 'invalid');
  } finally {
    runRequested = false;
    pendingRunRequest = false;
    renderStatus();
  }
}
$('#flow-run').onclick = () => runFlow();

// Step by step: from idle, start paused at the first step; when paused, run one step
async function stepFlow() {
  if (pausedLine != null) {
    try { await api('/api/flow/step', {}); } catch (e) { log(`[flow] ${e.data?.error || e.message}`); }
  } else if ($('#flow-stop').disabled) {
    runFlow(true);
  }
}
async function continueFlow() {
  if (pausedLine == null) return;
  try { await api('/api/flow/continue', {}); } catch (e) { log(`[flow] ${e.data?.error || e.message}`); }
}
$('#flow-step').onclick = stepFlow;
$('#flow-new').onclick = () => openInTab(BLANK_FLOW, null, true);
$('#flow-continue').onclick = continueFlow;
$('#flow-stop').onclick = () => api('/api/flow/stop', {}).catch((e) => log(`[flow] ${e.message}`));
$('#flow-check').onclick = async () => {
  clearMarks();
  flowOut.textContent = '';
  try {
    const r = await api('/api/flow/check', { source: flowSrc.value });
    outRow('passed', null, `syntax OK — ${r.steps} top-level step(s)`);
    setFlowStatus('passed', 'valid');
  } catch (err) {
    const d = err.data || {};
    if (d.line) setMark(d.line, 'error');
    outRow('failed', d.line, d.error || err.message);
    setFlowStatus('failed', 'invalid');
  }
};

function loadFlowText(text, file = null) {
  openInTab(text, file);
  setTimeout(() => { highlightFlow(); scheduleLint(); }, 0);
  flowSrc.scrollTop = 0;
  if ($('#flow-stop').disabled) { flowOut.textContent = ''; setFlowStatus(null, ''); }
}
$('#flow-file').onchange = async (e) => {
  const f = e.target.files[0];
  if (f) loadFlowText(await f.text(), f.name);
  e.target.value = '';
};
$('#flow-save').onclick = () => {
  if (!activeTab) return;
  const base = activeTab.file ? activeTab.file.split('/').pop().replace(/\.ya?ml$/, '') : null;
  const name = base || (flowSrc.value.match(/^name:\s*["']?([\w.-]+)/m) || [])[1] || 'flow';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([flowSrc.value], { type: 'text/yaml' }));
  a.download = `${name}.yaml`;
  a.click();
  if (!activeTab.file) activeTab.file = `${name}.yaml`;
  activeTab.orig = activeTab.text;                 // saved: no longer "modified"
  renderFlowTabs();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

const examples = $('#flow-examples');
api('/api/flows').then(({ flows }) => {
  for (const f of flows) examples.append(new Option(f, f));
}).catch(() => {});
examples.onchange = async () => {
  const name = examples.value;
  examples.value = '';
  if (!name) return;
  const res = await fetch(`/api/flows/${encodeURI(name)}`);
  if (res.ok) loadFlowText(await res.text(), name);
};

// ---------------------------------------------------------------- tabs
const TABS = ['flow', 'results', 'cmds', 'msgs', 'rpc', 'config'];
function showTab(name) {
  if (name === 'ref') name = 'cmds';            // old link
  if (!TABS.includes(name)) name = 'flow';
  for (const t of TABS) {
    $(`#tab-${t}`).hidden = t !== name;
    const b = $(`#tabbtn-${t}`);
    b.setAttribute('aria-selected', t === name);
    b.tabIndex = t === name ? 0 : -1;
  }
  localStorage.setItem('jw-tab', name);
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  if (name === 'flow') renderGutter();          // sizes are only known when visible
  if (name === 'cmds' || name === 'msgs') loadReference();
  if (name === 'results') loadRuns();
}
document.querySelectorAll('.tabs button').forEach((b) => {
  b.onclick = () => showTab(b.dataset.tab);
  b.onkeydown = (e) => {
    const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!d) return;
    const next = TABS[(TABS.indexOf(b.dataset.tab) + d + TABS.length) % TABS.length];
    showTab(next); $(`#tabbtn-${next}`).focus();
  };
});
window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

// ---------------------------------------------------------------- reference
const GROUPS = {
  immediate: ['immediate', 'answered immediately, even while busy'],
  always: ['no wallet', 'available before the wallet is unlocked'],
  unlocked: ['needs wallet', 'requires an unlocked wallet (auth_user, or debug_set_mnemonic in debug builds)'],
  debug: ['debug', 'debug builds only (libjade is a debug build)'],
  protocol: ['protocol', 'only valid as part of a multi-message exchange (eg. after ota or sign_tx)'],
};
let refData = null, refGroup = null;

// text with `code` spans -> DOM nodes (no innerHTML, so doc text can't inject markup)
function richText(tag, cls, text) {
  const e = el(tag, cls);
  text.split(/(`[^`]+`)/).forEach((part, i) => {
    e.append(i % 2 ? el('code', null, part.slice(1, -1)) : document.createTextNode(part));
  });
  return e;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Put `text` (one or more YAML step lines) into the flow editor at the cursor line
function insertIntoFlow(text) {
  showTab('flow');
  const src = flowSrc.value;
  let pos = flowSrc.selectionEnd ?? src.length;
  if (document.activeElement !== flowSrc && flowSrc.selectionStart === 0 && flowSrc.selectionEnd === 0) pos = src.length;
  const lineEnd = src.indexOf('\n', pos);
  pos = lineEnd < 0 ? src.length : lineEnd + 1;          // after the current line
  const prefix = pos > 0 && src[pos - 1] !== '\n' ? '\n' : '';
  const block = prefix + text.replace(/\n?$/, '\n');
  flowSrc.focus();
  flowSrc.setRangeText(block, pos, pos, 'end');
  flowSrc.dispatchEvent(new Event('input'));
}

function execStep(m) {
  const lines = ['- exec:', `    method: ${m.method}`];
  if (m.params != null) lines.push(`    params: ${JSON.stringify(m.params)}`);
  lines.push(`    as: ${m.method.replace(/^(get|debug|sign|register)_/, '').replace(/_/g, '') || 'result'}`);
  return lines.join('\n');
}

function tryInConsole(m) {
  showTab('rpc');
  $('#rpc-method').value = m.method;
  $('#rpc-params').value = m.params != null ? JSON.stringify(m.params, null, 2) : '';
  $('#rpc-params').focus();
  $('#rpc-form').scrollIntoView({ block: 'nearest' });
}

function renderCommands(cmds) {
  const box = $('#ref-commands');
  box.textContent = '';
  for (const c of cmds) {
    const row = el('div', 'ref-cmd');
    row.append(el('div', 'nm', c.name));
    const right = el('div');
    right.append(richText('div', 'ds', c.description));
    right.append(el('pre', null, c.syntax));
    const ex = el('div', 'ex');
    ex.append(el('pre', null, c.example));
    const ins = el('button', null, 'Insert');
    ins.type = 'button';
    ins.title = 'Insert this example into the flow editor';
    ins.onclick = () => insertIntoFlow(c.example);
    ex.append(ins);
    right.append(ex);
    row.append(right);
    box.append(row);
  }
}

function renderMethods() {
  const q = $('#ref-search').value.trim().toLowerCase();
  const box = $('#ref-methods');
  box.textContent = '';
  const list = refData.methods.filter((m) => (!refGroup || m.group === refGroup) &&
    (!q || m.method.includes(q) || m.description.toLowerCase().includes(q)));
  $('#ref-count').textContent = `${list.length} of ${refData.methods.length}`;
  if (!list.length) { box.append(el('div', 'ref-empty', 'No message matches.')); return; }
  for (const m of list) {
    const d = el('details', 'ref-m');
    const sum = el('summary');
    sum.append(el('span', 'mn', m.method));
    const [label, tip] = GROUPS[m.group] || [m.group, ''];
    const badge = el('span', `badge ${m.group}`, label); badge.title = tip;
    sum.append(badge);
    for (const f of m.flags) { const fb = el('span', 'badge', f.replace(/^CONFIG_/, '')); fb.title = `needs ${f}`; sum.append(fb); }
    sum.append(el('span', 'sd', m.description));
    d.append(sum);

    d.addEventListener('toggle', () => {
      if (!d.open || d.dataset.built) return;
      d.dataset.built = '1';
      const body = el('div', 'body');
      body.append(el('p', 'muted', tip));
      if (m.group !== 'protocol') {
        const acts = el('div', 'acts');
        const add = el('button', null, '+ Add exec step to flow'); add.type = 'button';
        add.onclick = () => insertIntoFlow(execStep(m));
        const tryb = el('button', null, 'Try in RPC console'); tryb.type = 'button';
        tryb.onclick = () => tryInConsole(m);
        acts.append(add, tryb);
        body.append(acts);
      }
      if (!m.sections.length) {
        if (m.description) body.append(richText('p', null, m.description));
        if (m.params != null) { body.append(el('h3', null, 'example params')); body.append(el('pre', null, JSON.stringify(m.params, null, 2))); }
        if (!m.description) body.append(el('p', 'muted', 'Not described in docs/index.rst.'));
      }
      for (const s of m.sections) {
        body.append(el('h3', null, s.title));
        if (s.text) body.append(richText('p', null, s.text));
        if (s.code) body.append(el('pre', null, s.code));
      }
      d.append(body);
    });
    box.append(d);
  }
}

let refRendered = false;
async function loadReference() {
  if (refRendered) return;
  refRendered = true;
  try {
    refData = refData || await api('/api/reference');
  } catch (e) {
    refRendered = false;
    $('#ref-methods').textContent = `Could not load the reference: ${e.message}`;
    return;
  }
  renderCommands(refData.commands);
  const chips = $('#ref-groups');
  const mk = (key, label, tip) => {
    const b = el('button', null, label); b.type = 'button'; b.title = tip || '';
    b.setAttribute('aria-pressed', refGroup === key);
    b.onclick = () => {
      refGroup = key;
      chips.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b));
      renderMethods();
    };
    chips.append(b);
  };
  mk(null, `all (${refData.methods.length})`);
  for (const [key, [label, tip]] of Object.entries(GROUPS)) {
    const n = refData.methods.filter((m) => m.group === key).length;
    if (n) mk(key, `${label} (${n})`, tip);
  }
  $('#ref-search').oninput = renderMethods;
  renderMethods();
}


// ---------------------------------------------------------------- suites ("Run all flows")
let suiteRow = null;

function onSuiteEvent(e) {
  if (e.t < PAGE_LOADED_T) return;
  if (e.event === 'start') {
    liveSuite = { id: e.suite, name: e.name, total: e.total, index: 0,
                  current: null, pending: [], cancelled: [], running: true };
    flowOut.textContent = '';
    clearMarks();
    outRow('running', null, `running ${e.name}: ${e.total} flows`);
    setFlowStatus('running', `suite 0/${e.total}`);
    $('#suite-run').disabled = true;
  } else if (e.event === 'cancelled_flow') {
    if (liveSuite?.id === e.suite && !liveSuite.cancelled.includes(e.file)) liveSuite.cancelled.push(e.file);
    outRow('cancelled', null, `${e.file} — cancelled (${e.reason})`);
  } else if (e.event === 'end') {
    playCompletionSound();
    stopFlowTimeout();
    if (liveSuite?.id === e.suite) {
      liveSuite.running = false;
      liveSuite.current = null;
      liveSuite.pending = [];
    }
    lastRunSummary = { status: e.status,
      text: `Suite ${e.status}: ${e.passed}/${e.total} passed${e.failed ? ` · ${e.failed} failed` : ''}` +
        (e.cancelled ? ` · ${e.cancelled} cancelled` : '') };
    const end = el('div', `end ${e.status}`,
      `suite ${e.status}: ${e.passed}/${e.total} flows passed` + (e.failed ? `, ${e.failed} failed` : '') +
      (e.cancelled ? `, ${e.cancelled} cancelled` : '') +
      ` in ${e.seconds}s — details in the Results tab`);
    flowOut.append(end);
    flowOut.scrollTop = flowOut.scrollHeight;
    setFlowStatus(e.status, `suite ${e.status}`);
    $('#suite-run').disabled = false;
  }
}

function onSuiteFlowEvent(e) {
  if (e.event === 'start') {
    setFlowStatus('running', `suite ${e.suite.index}/${e.suite.total}`);
    suiteRow = outRow('running', null, `[${e.suite.index}/${e.suite.total}] ${e.file}`);
  } else if (e.event === 'step' && (e.status === 'failed' || e.status === 'stopped' || e.status === 'cancelled')) {
    outRow(e.status, e.line, `   ${e.text}`, e.detail);
  } else if (e.event === 'end') {
    const row = outRow(e.status, null, suiteRow ? suiteRow.querySelector('.tx').textContent : e.dir,
      `${e.status} in ${e.seconds}s` + (e.error ? ` — ${e.error}` : '') +
      (e.firmware_errors ? ` · ⚠ ${e.firmware_errors} firmware error(s)` : ''));
    if (suiteRow) { suiteRow.replaceWith(row); suiteRow = null; }
  }
}

$('#suite-run').onclick = async () => {
  if (pipelineOccupied()) return;
  primeCompletionSound();
  try {
    await api('/api/suite/run', { dir: '' });
  } catch (err) {
    flowOut.textContent = '';
    outRow('failed', null, err.data?.error || err.message);
  }
};

// ---------------------------------------------------------------- results (run history)
let runsCache = [], runsTimer = null, liveSuite = null;
const runsSelected = new Set();
const runsOpen = new Set();
const suitesOpen = new Set();   // suite ids shown expanded (each suite is one line until clicked)

function runsChanged() {
  // debounce: suites emit many events; only refresh when the tab is visible
  clearTimeout(runsTimer);
  runsTimer = setTimeout(() => { if (!$('#tab-results').hidden) loadRuns(); else updateRunsBadge(); }, 400);
}

async function updateRunsBadge() {
  try {
    const { runs } = await api('/api/runs');
    runsCache = runs;
    const failed = runs.filter((r) => r.status === 'failed').length;
    const b = $('#results-badge');
    b.textContent = failed ? failed : '';
    b.title = failed ? `${failed} failed run(s)` : '';
  } catch { /* ignore */ }
}

const fmtTime = (t) => t ? new Date(t * 1000).toLocaleString() : '';
const ICON = { running: '▶', passed: '✓', failed: '✗', stopped: '■', cancelled: '⊘' };

async function loadRuns() {
  let data;
  try { data = await api('/api/runs'); } catch (e) { $('#runs-list').textContent = e.message; return; }
  runsCache = data.runs;
  runsBusy = !!data.busy;
  if (data.suite) {
    if (liveSuite?.id !== data.suite.id) {
      liveSuite = { id: data.suite.id, name: data.suite.name, cancelled: [], running: true };
    }
    liveSuite.total = data.suite.total;
    liveSuite.index = data.suite.index;
    liveSuite.current = data.suite.current;
    liveSuite.running = true;
    liveSuite.pending = data.suite.cancel_reason ? [] : [...(data.suite.pending || [])];
    if (data.suite.cancel_reason) {
      for (const file of [...(data.suite.cancelled_files || []), ...(data.suite.pending || [])]) {
        if (!liveSuite.cancelled.includes(file)) liveSuite.cancelled.push(file);
      }
    }
  }
  for (const d of [...runsSelected]) if (!runsCache.some((r) => r.dir === d)) runsSelected.delete(d);
  renderRuns();
  updateRunsBadge();
}

function renderRuns() {
  const filter = $('#runs-filter').value;
  const allRuns = [...runsCache];
  if (liveSuite) {
    const suiteLabel = (file) => liveSuite.name === 'all flows' || file.startsWith(`${liveSuite.name}/`)
      ? file : `${liveSuite.name}/${file}`;
    const currentFile = liveSuite.current ? suiteLabel(liveSuite.current) : null;
    const actualFiles = new Set(runsCache.filter((r) => r.suite?.id === liveSuite.id).map((r) => r.file));
    const addPlaceholder = (file, status, index) => {
      const displayFile = suiteLabel(file);
      if (actualFiles.has(displayFile)) return;
      allRuns.push({ dir: `__${status}_${liveSuite.id}_${displayFile}`, name: displayFile,
        file: displayFile, status, synthetic: true,
        suite: { id: liveSuite.id, name: liveSuite.name, index, total: liveSuite.total } });
    };
    if (currentFile && !actualFiles.has(currentFile)) addPlaceholder(liveSuite.current, 'running', liveSuite.index || 1);
    const cancelled = new Set(liveSuite.cancelled.map(suiteLabel));
    [...cancelled].forEach((file, i) => addPlaceholder(file, 'cancelled', (liveSuite.index || 0) + i + 1));
    liveSuite.pending.forEach((file, i) => {
      if (!cancelled.has(suiteLabel(file))) addPlaceholder(file, 'pending', (liveSuite.index || 0) + i + 1);
    });
  }
  const runs = allRuns.filter((r) => !filter || (filter === 'fwerrors' ? r.firmware_errors > 0 : r.status === filter));
  const total = allRuns.length;
  const n = (st) => allRuns.filter((r) => r.status === st).length;
  $('#runs-summary').textContent = total
    ? `${total} run(s) · ${n('passed')} passed · ${n('failed')} failed` +
      (n('cancelled') ? ` · ${n('cancelled')} cancelled` : '') + (n('stopped') ? ` · ${n('stopped')} stopped` : '')
    : '';
  const list = $('#runs-list');
  list.textContent = '';
  if (!runs.length) {
    list.append(el('div', 'ref-empty', total ? 'No run matches the filter.' : 'No runs yet — run a flow or "Run all flows".'));
    updateSelectionUi();
    return;
  }
  // Keep every run and pending flow for a suite together.
  const groups = [];
  const bySuite = new Map();
  for (const r of runs) {
    const sid = r.suite?.id;
    if (sid && bySuite.has(sid)) bySuite.get(sid).runs.push(r);
    else {
      const group = { suite: sid, name: r.suite?.name, runs: [r] };
      groups.push(group);
      if (sid) bySuite.set(sid, group);
    }
  }
  for (const g of groups) {
    if (!g.suite) { list.append(runRow(g.runs[0])); continue; }
    const box = el('div', 'suite-box');
    const head = el('div', 'suite-head');
    const cb = el('input'); cb.type = 'checkbox';
    cb.title = 'select every run of this suite';
    const selectable = g.runs.filter((r) => !r.synthetic);
    cb.checked = selectable.length > 0 && selectable.every((r) => runsSelected.has(r.dir));
    cb.disabled = selectable.length === 0;
    cb.onchange = () => { for (const r of selectable) cb.checked ? runsSelected.add(r.dir) : runsSelected.delete(r.dir); renderRuns(); };
    cb.onclick = (e) => e.stopPropagation();
    const isOpen = suitesOpen.has(g.suite);
    head.title = isOpen ? 'Hide the flows of this run' : 'Show every flow of this run';
    head.onclick = () => { isOpen ? suitesOpen.delete(g.suite) : suitesOpen.add(g.suite); renderRuns(); };
    const seconds = g.runs.reduce((a, r) => a + (r.seconds || 0), 0);
    const failed = g.runs.filter((r) => r.status === 'failed').length;
    const running = g.runs.some((r) => r.status === 'running' || r.status === 'pending');
    const cancelled = g.runs.some((r) => r.status === 'cancelled');
    const st = running ? 'running' : failed ? 'failed' : cancelled ? 'cancelled' :
      g.runs.every((r) => r.status === 'passed') ? 'passed' : 'stopped';
    head.append(cb, el('span', 'caret', isOpen ? '▾' : '▸'), el('span', `ic ${st}`, ICON[st]),
      el('span', 'nm', g.name === 'all flows' ? 'all flows' : `suite ${g.name}`),
      el('span', 'meta', `${fmtTime(g.runs.find((r) => !r.synthetic)?.started)} · ${g.runs.length}/${g.runs[0].suite.total} flows · ` +
        `${g.runs.filter((r) => r.status === 'passed').length} passed` + (failed ? ` · ${failed} failed` : '') +
        (cancelled ? ` · ${g.runs.filter((r) => r.status === 'cancelled').length} cancelled` : '') +
        (seconds ? ` · ${fmtDuration(seconds)}` : '')));
    box.append(head);
    if (isOpen) {
      for (const r of [...g.runs].sort((a, b) => (a.suite.index - b.suite.index))) {
        box.append(r.synthetic ? pendingRow(r) : runRow(r));
      }
    } else box.classList.add('collapsed');
    list.append(box);
  }
  updateSelectionUi();
}

// The emulated firmware a run used, short: "Jade v2 1.0.41-220-ga59d14c2" (+ "CI")
function fwShort(fw) {
  if (!fw) return null;
  const board = { 'jade-v1': 'Jade v1', 'jade-v2': 'Jade v2' }[fw.board] || fw.board || '';
  return [board, fw.jade_version, fw.ci ? 'CI' : null].filter(Boolean).join(' ') || fw.file;
}

function runRow(r) {
  const wrap = el('div', `run ${r.status}`);
  const row = el('div', 'run-row');
  const cb = el('input'); cb.type = 'checkbox';
  cb.checked = runsSelected.has(r.dir);
  cb.disabled = r.status === 'running';
  cb.onclick = (e) => e.stopPropagation();
  cb.onchange = () => { cb.checked ? runsSelected.add(r.dir) : runsSelected.delete(r.dir); updateSelectionUi(); };
  const steps = r.steps || {};
  const done = Object.values(steps).reduce((a, b) => a + b, 0);
  row.append(cb, el('span', `ic ${r.status}`, ICON[r.status] || '·'),
    el('span', 'nm', r.file || r.name),
    el('span', 'meta', [r.suite ? null : fmtTime(r.started),
      r.seconds != null ? `${r.seconds}s` : null,
      `${steps.passed || 0}/${r.steps_total ?? done} steps`,
      r.screenshots?.length ? `📷 ${r.screenshots.length}` : null,
      fwShort(r.firmware)].filter(Boolean).join(' · ')));
  if (r.firmware_errors) {
    const w = el('span', 'fw-errors', `⚠ ${r.firmware_errors} firmware error${r.firmware_errors > 1 ? 's' : ''}`);
    w.title = 'The firmware logged errors while this flow ran (open the run to see them under their steps)';
    row.append(w);
  }
  row.append(rerunButton(r, 'small-btn rerun', '↻'));
  if (r.error) row.append(el('span', 'err', r.error));
  row.onclick = () => {
    runsOpen.has(r.dir) ? runsOpen.delete(r.dir) : runsOpen.add(r.dir);
    toggleDetail(wrap, r);
  };
  wrap.append(row);
  if (runsOpen.has(r.dir)) toggleDetail(wrap, r, true);
  return wrap;
}

function pendingRow(r) {
  const wrap = el('div', `run ${r.status} pending-row`);
  const row = el('div', 'run-row');
  row.append(el('span', `ic ${r.status}`, ICON[r.status] || '…'),
    el('span', 'nm', r.file), el('span', 'meta', r.status));
  if (r.status === 'cancelled') row.append(restartQueuedFlowButton(r));
  wrap.append(row);
  return wrap;
}

// Cancelled suite entries have no run directory to rerun, so load the flow file
// and start it directly from the Results list.
function restartQueuedFlowButton(r) {
  const b = el('button', 'small-btn rerun', '↻'); b.type = 'button';
  b.title = `Restart ${r.file}`;
  b.disabled = runsBusy || pipelineOccupied();
  b.onclick = async (e) => {
    e.stopPropagation();
    if (pipelineOccupied()) return;
    primeCompletionSound();
    b.disabled = true;
    try {
      const path = String(r.file || '').split('/').map(encodeURIComponent).join('/');
      const res = await fetch(`/api/flows/${path}`);
      if (!res.ok) throw new Error(`Could not load ${r.file} (${res.status})`);
      const source = await res.text();
      const run = await api('/api/flow/run', { source });
      log(`[results] restarted ${r.file} → ${run.id}`);
      runsBusy = true;
      loadRuns();
    } catch (err) {
      log(`[results] restart failed for ${r.file}: ${err.message}`);
      b.disabled = false;
    }
  };
  return b;
}

async function toggleDetail(wrap, r, forceOpen) {
  const existing = wrap.querySelector('.run-detail');
  if (existing && !forceOpen) { existing.remove(); return; }
  if (existing) return;
  const det = el('div', 'run-detail', 'loading…');
  wrap.append(det);
  let rec;
  try { rec = await api(`/api/runs/${encodeURIComponent(r.dir)}`); }
  catch (e) { det.textContent = e.message; return; }
  det.textContent = '';
  const acts = el('div', 'acts');
  const open = el('button', null, 'Open in editor'); open.type = 'button';
  open.onclick = () => { openInTab(rec.source || '', null, true); showTab('flow'); };
  const del = el('button', 'danger', 'Delete run'); del.type = 'button';
  del.disabled = r.status === 'running';
  del.onclick = () => deleteRuns([r.dir]);
  const exp = el('button', null, 'Export HTML'); exp.type = 'button';
  exp.title = 'Download this run as a zipped HTML report with its screenshots';
  exp.onclick = () => exportRuns([r.dir]);
  acts.append(rerunButton(r, 'primary', '↻ Run again'), open, exp, del, el('span', 'muted small', ` ${r.dir}`));
  det.append(acts);
  if (rec.firmware) {
    det.append(el('div', 'muted small run-fw', `Firmware: ${rec.firmware.label || rec.firmware.file} — ${rec.firmware.file}`));
  }
  const shotsBox = (paths) => {
    const g = el('div', 'gallery step-shots');
    for (const p of paths) {
      const a = el('a', 'image-preview-link'); a.href = `/screenshots/${encodeURI(p)}`; a.title = p;
      const img = el('img'); img.src = a.href; img.alt = p; img.loading = 'lazy';
      a.append(img, el('span', null, p.split('/').pop()));
      g.append(a);
    }
    return g;
  };
  const steps = el('div', 'run-steps');
  const recs = rec.records || [];
  const failedFirst = recs.filter((s) => s.status !== 'passed');
  if (recs.length > 60 && failedFirst.length < recs.length) {
    steps.append(el('div', 'muted small', `${recs.length} steps (${recs.length - failedFirst.length} passed${failedFirst.length ? ', problems listed first' : ''})`));
  }
  const ordered = recs.length > 60 ? [...failedFirst, ...recs.filter((s) => s.status === 'passed')] : recs;
  const shown = new Set();
  for (const s of ordered) {
    const line = el('div', `st ${s.status}` + (/^expect\b/.test(s.text || '') ? ' expect' : ''));
    line.append(el('span', 'ic', ICON[s.status] || '·'), el('span', 'ln', s.line ?? ''));
    const tx = el('span', 'tx', s.text);
    if (s.detail != null && s.detail !== '') tx.append(el('span', 'dt', `  → ${s.detail}`));
    for (const fe of s.firmware_errors || []) tx.append(el('div', 'fwe', `⚠ firmware error: ${fe}`));
    line.append(tx);
    steps.append(line);
    // screenshots appear in the log, under the step that took them
    if (s.screenshots?.length) { steps.append(shotsBox(s.screenshots)); s.screenshots.forEach((p) => shown.add(p)); }
  }
  const rest = (rec.screenshots || []).filter((p) => !shown.has(p));   // eg. older runs without per-step data
  if (rest.length) steps.append(shotsBox(rest));
  det.append(steps);
}

// Run a past run's flow again: from its file under flows/ when it has one (picks up
// edits and regenerated flows), else from the source saved with the run
function rerunButton(r, cls, label) {
  const b = el('button', cls, label); b.type = 'button';
  b.dataset.running = String(r.status === 'running');
  b.title = r.file ? `Run ${r.file} again (re-read from flows/)` : 'Run this flow again (the source saved with the run)';
  b.disabled = pipelineOccupied() || runsBusy || r.status === 'running';
  b.onclick = async (e) => {
    e.stopPropagation();
    if (pipelineOccupied()) return;
    primeCompletionSound();
    b.disabled = true;
    try {
      const res = await api('/api/runs/rerun', { dir: r.dir });
      log(`[results] running ${res.file || r.name} again → ${res.dir}`);
      runsBusy = true;
      runsOpen.add(res.dir);
      loadRuns();
    } catch (err) {
      log(`[results] run again failed: ${err.data?.error || err.message}`);
      b.disabled = false;
    }
  };
  return b;
}

function updateSelectionUi() {
  $('#runs-delete-selected').disabled = runsSelected.size === 0;
  $('#runs-export-selected').disabled = runsSelected.size === 0;
  $('#runs-export-selected').textContent = runsSelected.size ? `Export selected (${runsSelected.size})` : 'Export selected';
  $('#runs-export-all').disabled = runsCache.length === 0;
  $('#runs-delete-selected').textContent = runsSelected.size ? `Delete selected (${runsSelected.size})` : 'Delete selected';
  const deletable = runsCache.filter((r) => r.status !== 'running');
  const all = $('#runs-select-all');
  all.checked = deletable.length > 0 && deletable.every((r) => runsSelected.has(r.dir));
  all.indeterminate = !all.checked && runsSelected.size > 0;
  $('#runs-delete-all').disabled = deletable.length === 0;
}

async function deleteRuns(dirs, all = false) {
  const what = all ? `all ${runsCache.length} runs` : `${dirs.length} run(s)`;
  if (!confirm(`Delete ${what} and their screenshots? This cannot be undone.`)) return;
  try {
    const r = await api('/api/runs/delete', all ? { all: true } : { dirs });
    for (const d of r.deleted) { runsSelected.delete(d); runsOpen.delete(d); }
    log(`[results] deleted ${r.deleted.length} run(s)` + (r.skipped.length ? `, skipped ${r.skipped.length} (running or missing)` : ''));
  } catch (e) { log(`[results] ${e.message}`); }
  loadRuns();
}

// Zipped HTML report (index.html + screenshots + run.json per run), built by the server
async function exportRuns(dirs, all = false) {
  const what = all ? 'all runs' : `${dirs.length} run(s)`;
  log(`[results] exporting ${what}…`);
  try {
    const res = await fetch('/api/runs/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(all ? { all: true } : { dirs }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'jade.church-report.zip';
    const url = URL.createObjectURL(await res.blob());
    const a = el('a'); a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    log(`[results] exported ${what} → ${name}`);
  } catch (e) { log(`[results] export failed: ${e.message}`); }
}

$('#runs-export-selected').onclick = () => exportRuns([...runsSelected]);
$('#runs-export-all').onclick = () => exportRuns([], true);
$('#runs-refresh').onclick = loadRuns;
$('#runs-filter').onchange = renderRuns;
$('#runs-delete-selected').onclick = () => deleteRuns([...runsSelected]);
$('#runs-delete-all').onclick = () => deleteRuns([], true);
$('#runs-select-all').onchange = (e) => {
  for (const r of runsCache) if (r.status !== 'running') e.target.checked ? runsSelected.add(r.dir) : runsSelected.delete(r.dir);
  renderRuns();
};
updateRunsBadge();


// ---------------------------------------------------------------- flow editor: highlighting
const STEP_NAMES = ['left', 'right', 'confirm', 'click', 'sleep', 'wait', 'waitForChange', 'screenshot',
  'exec', 'await', 'approve', 'expect', 'decrypt', 'http', 'send', 'receive', 'log', 'repeat', 'restart'];
const CONFIG_KEYS = ['name', 'settle', 'timeout', 'steps', 'firmwareErrors', 'ignoreErrors'];
const STEP_OPTIONS = {
  exec: ['method', 'params', 'as', 'async', 'timeout', 'expect', 'allowError', 'followHttp'],
  await: ['name', 'timeout', 'expect', 'allowError'],
  approve: ['name', 'timeout', 'max', 'screenshots'],
  send: ['data', 'cbor'],
  http: ['request', 'as'],
  decrypt: ['as', 'privkey', 'pubkey', 'encrypted', 'label'],
  receive: ['as', 'count', 'until', 'timeout'],
  expect: ['var', 'equals', 'notEquals', 'contains', 'startsWith', 'matches'],
  screenshot: ['name', 'scale'],
  waitForChange: ['timeout'],
  repeat: ['times', 'steps'],
};
const OPTION_DOCS = {
  method: 'Jade RPC method name', params: 'parameters map for the method ("hex:…" for bytes)',
  as: 'store the result in this variable', async: 'true: continue without waiting; collect with await',
  timeout: 'fail if no reply within this many ms', expect: 'fail unless the result equals this value',
  allowError: 'true: an error reply does not fail the flow', name: 'name', scale: 'PNG scale factor',
  var: 'variable (or var.path) to check', equals: 'exact value', notEquals: 'anything but this value', contains: 'substring of the text form',
  startsWith: 'prefix of the text form', matches: 'regular expression', times: 'repeat count',
  steps: 'nested steps list', max: 'fail after this many screens',
  screenshots: 'approve: save every screen as PREFIX-1, PREFIX-2, … (or true)',
  data: 'raw bytes: "hex:…" or "file:path"', cbor: 'a value to encode as CBOR and send',
  privkey: 'host private key ("hex:…") whose pubkey was sent', pubkey: 'Jade\'s ephemeral pubkey from the reply',
  encrypted: 'the encrypted bytes from the reply', label: 'key-derivation label, eg. bip85_bip39_entropy',
  followHttp: 'false: return an http_request reply instead of relaying it',
  request: 'the http_request params from a reply', count: 'stop after this many replies', until: 'stop at the reply with this id',
};
const NETWORKS = ['mainnet', 'testnet', 'localtest', 'liquid', 'testnet-liquid', 'localtest-liquid'];
const VARIANTS = ['wpkh(k)', 'sh(wpkh(k))', 'pkh(k)', 'tr(k)'];
const flowHl = $('#flow-hl');
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (cls, t) => `<span class="${cls}">${esc(t)}</span>`;
let knownMethods = null;    // Set of Jade method names, once the reference is loaded

function splitComment(line) {
  // '#' starts a comment at line start or after whitespace, outside quotes
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return [line.slice(0, i), line.slice(i)];
  }
  return [line, ''];
}

function hlString(t) {
  // strings, with ${var} references highlighted inside
  return t.split(/(\$\{[^}]*\}?)/).map((p, i) => i % 2 ? span('c-var', p) : span('c-str', p)).join('');
}

const TOKEN_RE = /("(?:[^"\\]|\\.)*"?|'[^']*'?)|(\$\{[^}]*\}?)|\b(true|false|null)\b|(\b0x[0-9a-fA-F]+\b|-?\b\d+(?:\.\d+)?(?:ms|s|m)?\b)|([A-Za-z_][\w-]*)(\s*:)(?=\s|$|[{\[,])|([{}\[\],])|([^\s{}\[\],:"']+)/g;

function hlCode(code, inConfig) {
  let out = '', last = 0, m, prevKey = null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(code))) {
    out += esc(code.slice(last, m.index));
    last = TOKEN_RE.lastIndex;
    if (m[1] !== undefined) out += hlString(m[1]);
    else if (m[2] !== undefined) out += span('c-var', m[2]);
    else if (m[3] !== undefined) out += span('c-bool', m[3]);
    else if (m[4] !== undefined) out += span('c-num', m[4]);
    else if (m[5] !== undefined) {
      const key = m[5];
      const cls = inConfig && CONFIG_KEYS.includes(key) ? 'c-ckey' : 'c-key';
      out += span(cls, key) + span('c-punc', m[6]);
      prevKey = key;
      continue;
    } else if (m[7] !== undefined) out += span('c-punc', m[7]);
    else if (m[8] !== undefined) {
      const isMethod = (prevKey === 'method' || prevKey === 'exec') && knownMethods;
      out += span(isMethod ? (knownMethods.has(m[8]) ? 'c-method' : 'c-bad') : 'c-val', m[8]);
    }
    prevKey = null;
  }
  return out + esc(code.slice(last));
}

function highlightFlow() {
  const lines = flowSrc.value.split('\n');
  const hasDoc = lines.some((l) => l.trim() === '---');
  let inConfig = hasDoc;
  const html = lines.map((line) => {
    if (line.trim() === '---') { inConfig = false; return span('c-doc', line); }
    const [code, comment] = splitComment(line);
    let out;
    const step = code.match(/^(\s*)(-)(\s+)([A-Za-z_]\w*)(\s*:)?(?=\s|$)(.*)$/);
    if (step) {
      const [, ind, dash, sp, name, colon, rest] = step;
      const cls = STEP_NAMES.includes(name) ? 'c-step' : (colon ? 'c-key' : 'c-bad');
      // nested "- key:" lines inside a mapping (eg. repeat steps) are still steps
      out = esc(ind) + span('c-dash', dash) + esc(sp) + span(cls, name) +
        (colon ? span('c-punc', colon) : '') + hlCode(rest, false).replace(/^/, '');
      if (colon && (name === 'exec')) {
        // highlight an inline method name: "- exec: get_xpub"
        out = esc(ind) + span('c-dash', dash) + esc(sp) + span(cls, name) + span('c-punc', colon) +
          hlCode('exec:' + rest, false).replace(/^<span class="c-key">exec<\/span><span class="c-punc">:<\/span>/, '');
      }
    } else {
      out = hlCode(code, inConfig);
    }
    return out + (comment ? span('c-com', comment) : '');
  }).join('\n');
  flowHl.innerHTML = html + '\n\n';
  syncHl();
}
function syncHl() { flowHl.scrollTop = flowSrc.scrollTop; flowHl.scrollLeft = flowSrc.scrollLeft; }

flowSrc.addEventListener('input', highlightFlow);
flowSrc.addEventListener('scroll', syncHl);
highlightFlow();

// ---------------------------------------------------------------- flow editor: suggestions
const sugBox = $('#flow-suggest');
let sug = null;             // {items, index, from, to}
let charW = 0;

async function ensureReference() {
  if (!refData) {
    try { refData = await api('/api/reference'); } catch { return null; }
  }
  if (!knownMethods) { knownMethods = new Set(refData.methods.map((m) => m.method)); highlightFlow(); }
  return refData;
}
ensureReference();

function docVars(text) {
  const vars = new Map([['last', 'result of the most recent exec/await']]);
  for (const m of text.matchAll(/\bas:\s*["']?([A-Za-z_]\w*)/g)) {
    const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index) >>> 0 || undefined);
    const meth = (line.match(/(?:method|exec):\s*([\w]+)/) || [])[1];
    vars.set(m[1], meth ? `result of ${meth}` + (/async:\s*true/.test(line) ? ' (async: await it)' : '') : 'stored result');
  }
  return vars;
}

function enclosingStep(lines, row, col) {
  // the step this position belongs to: same line "- name:" or the nearest less-indented "- name:" above
  const cur = lines[row].slice(0, col);
  let m = cur.match(/^\s*-\s*([A-Za-z]\w*)\s*:/);
  if (m) return { name: m[1], line: lines[row] };
  const indent = cur.match(/^\s*/)[0].length;
  for (let r = row - 1; r >= 0; r--) {
    const l = lines[r];
    if (!l.trim() || l.trim().startsWith('#')) continue;
    const li = l.match(/^\s*/)[0].length;
    m = l.match(/^\s*-\s*([A-Za-z]\w*)\s*:/);
    if (m && li < indent) return { name: m[1], line: l, row: r };
    if (li === 0 && !l.trim().startsWith('-')) break;
  }
  return null;
}

function methodOf(lines, row, step, before = '') {
  // nearest method before the cursor on this line wins, then the step's block
  const onLine = [...before.matchAll(/(?:method|exec):\s*["']?([\w]+)/g)].map((x) => x[1]).filter((x) => knownMethods?.has(x));
  if (onLine.length) return onLine[onLine.length - 1];
  const look = [lines[row]];
  if (step && step.row != null) for (let r = step.row; r <= row; r++) look.push(lines[r]);
  for (const l of look) { const m = l.match(/(?:method|exec):\s*["']?([\w]+)/); if (m && knownMethods?.has(m[1])) return m[1]; }
  return null;
}

const STEP_SNIPPETS = {
  left: ['left', 'press the left button'], right: ['right', 'press the right button'],
  confirm: ['confirm', 'press the select button'], sleep: ['sleep: ‸1s', 'pause: 500ms, 2s, 1.5m'],
  waitForChange: ['waitForChange', 'wait for the screen to change'],
  screenshot: ['screenshot: ‸name', 'save the Jade screen as PNG'],
  exec: ['exec: ‸', 'call a Jade RPC message'],
  await: ['await: ‸', 'collect an async exec'],
  approve: ['approve: ‸', 'accept every review screen until an async exec replies'],
  send: ['send: {data: "hex:‸"}', 'write raw bytes to the serial stream'],
  http: ['http: {request: "${‸.http_request.params}", as: resp}', 'perform a firmware http_request'],
  decrypt: ['decrypt: {as: ‸, privkey: "hex:", pubkey: "${r.pubkey}", encrypted: "${r.encrypted}", label: }', 'decrypt ECDH+AES data (eg. bip85 entropy)'],
  receive: ['receive: {as: ‸, count: 1}', 'collect replies to raw sends'],
  expect: ['expect: {var: ‸, equals: }', 'assert on a stored result'],
  log: ['log: "‸"', 'print a line (${var} substitution)'],
  repeat: ['repeat:\n    times: ‸2\n    steps:\n      - right', 'loop over nested steps'],
  restart: ['restart', 'power-cycle the device'],
};

function computeSuggestions(force) {
  const text = flowSrc.value, pos = flowSrc.selectionStart;
  if (pos !== flowSrc.selectionEnd) return null;
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const before = text.slice(lineStart, pos);
  const lines = text.split('\n');
  const row = text.slice(0, pos).split('\n').length - 1;
  if (splitComment(before)[1]) return null;               // inside a comment
  let m;
  const mk = (from, prefix, items) => {
    const p = prefix.toLowerCase();
    const scored = items.map((it) => {
      const l = it.label.toLowerCase();
      return { ...it, score: l.startsWith(p) ? 0 : l.includes(p) ? 1 : -1 };
    }).filter((it) => it.score >= 0 && (force || p === '' || it.label !== prefix));
    scored.sort((a, b) => a.score - b.score);
    return scored.length ? { items: scored.slice(0, 80), from, to: pos, prefix } : null;
  };

  // ${var
  if ((m = before.match(/\$\{([\w.]*)$/))) {
    return mk(pos - m[1].length, m[1], [...docVars(text)].map(([v, d]) => ({ label: v, insert: v + '}', kind: 'variable', doc: d })));
  }
  // "- " step name
  if ((m = before.match(/^(\s*)-\s+([A-Za-z]*)$/))) {
    return mk(pos - m[2].length, m[2], Object.entries(STEP_SNIPPETS).map(([k, [ins, d]]) => ({
      label: k, insert: ins.replace(/\n/g, '\n' + m[1]), kind: 'step', doc: (refData?.commands.find((c) => c.name.split(/\s*\/\s*/).includes(k))?.description) || d,
    })));
  }
  // method names after exec: / method:
  if ((m = before.match(/\b(exec|method):\s*["']?([\w]*)$/))) {
    if (!refData) { ensureReference().then(() => updateSuggest(force)); return null; }
    const inline = m[1] === 'exec' && /^\s*-\s*exec:\s*[\w]*$/.test(before);
    const items = [];
    for (const md of refData.methods) {
      if (md.group === 'protocol') continue;
      const kind = { immediate: 'immediate', always: 'no wallet', unlocked: 'needs wallet', debug: 'debug' }[md.group] || md.group;
      items.push({ label: md.method, insert: md.method, kind, doc: md.description });
      if (inline && md.params != null) {
        const asName = md.method.replace(/^(get|debug|sign|register)_/, '').replace(/_/g, '') || 'result';
        items.push({ label: md.method + ' {…}', insert: `{method: ${md.method}, params: ${JSON.stringify(md.params)}, as: ${asName}}`,
          kind: 'with params', doc: 'Full exec with the documented example params: ' + md.description });
      }
    }
    return mk(pos - m[2].length, m[2], items);
  }
  // await: NAME / approve: NAME
  if ((m = before.match(/\b(?:await|approve):\s*(?:\{\s*name:\s*)?([\w]*)$/))) {
    return mk(pos - m[1].length, m[1], [...docVars(text)].filter(([v]) => v !== 'last').map(([v, d]) => ({ label: v, insert: v, kind: 'async exec', doc: d })));
  }
  // var: NAME
  if ((m = before.match(/\bvar:\s*([\w.]*)$/))) {
    return mk(pos - m[1].length, m[1], [...docVars(text)].map(([v, d]) => ({ label: v, insert: v, kind: 'variable', doc: d })));
  }
  if ((m = before.match(/\bnetwork:\s*["']?([\w-]*)$/))) {
    return mk(pos - m[1].length, m[1], NETWORKS.map((n) => ({ label: n, insert: n, kind: 'network' })));
  }
  if ((m = before.match(/\bvariant:\s*["']?([\w()]*)$/))) {
    return mk(pos - m[1].length, m[1], VARIANTS.map((n) => ({ label: n, insert: `"${n}"`, kind: 'variant' })));
  }
  if ((m = before.match(/\b(settle|async|allowError):\s*(\w*)$/))) {
    return mk(pos - m[2].length, m[2], ['true', 'false'].map((n) => ({ label: n, insert: n, kind: 'boolean' })));
  }
  // params keys of the method: params: {ke  /  params: {a: 1, ke
  if ((m = before.match(/params:\s*\{(?:[^{}]*[,{]\s*|\s*)([\w]*)$/)) || (m = before.match(/params:\s*\{\s*([\w]*)$/))) {
    const step = enclosingStep(lines, row, before.length);
    const meth = methodOf(lines, row, step, before);
    const md = meth && refData?.methods.find((x) => x.method === meth);
    if (md && md.params && typeof md.params === 'object') {
      return mk(pos - m[1].length, m[1], Object.entries(md.params).map(([k, v]) => ({
        label: k, insert: `${k}: `, kind: 'param', doc: `${meth} example: ${JSON.stringify(v)}`,
      })));
    }
  }
  // option keys of the enclosing step, inline {…} or indented block
  if ((m = before.match(/(?:[{,]\s*|^\s+)([A-Za-z]*)$/))) {
    const step = enclosingStep(lines, row, before.length);
    const opts = step && STEP_OPTIONS[step.name];
    if (opts) {
      return mk(pos - m[1].length, m[1], opts.map((k) => ({ label: k, insert: `${k}: `, kind: `${step.name} option`, doc: OPTION_DOCS[k] })));
    }
  }
  // config keys at the top of the document (before ---)
  if ((m = before.match(/^([A-Za-z]*)$/)) && text.includes('\n---') && pos < text.indexOf('\n---')) {
    return mk(pos - m[1].length, m[1], [{ label: 'name', insert: 'name: ', kind: 'config', doc: 'names the run and its screenshot folder' },
      { label: 'settle', insert: 'settle: ', kind: 'config', doc: 'wait for the screen to settle after each press (default true)' },
      { label: 'timeout', insert: 'timeout: ', kind: 'config', doc: 'maximum flow duration in seconds (default 600)' },
      { label: 'firmwareErrors', insert: 'firmwareErrors: ', kind: 'config', doc: 'an ERROR logged by the firmware: warn (default), fail the step, or ignore' },
      { label: 'ignoreErrors', insert: 'ignoreErrors: ', kind: 'config', doc: 'regular expression(s) of expected firmware errors to ignore' }]);
  }
  // empty line in the step list: offer to start a step
  if (force && /^\s*$/.test(before)) {
    return mk(pos, '', Object.entries(STEP_SNIPPETS).map(([k, [ins, d]]) => ({ label: k, insert: '- ' + ins, kind: 'step', doc: d })));
  }
  return null;
}

function caretXY(pos) {
  if (!charW) {
    const c = document.createElement('canvas').getContext('2d');
    c.font = getComputedStyle(flowSrc).font;
    charW = c.measureText('0123456789').width / 10;
  }
  const before = flowSrc.value.slice(0, pos);
  const row = before.split('\n').length - 1;
  const col = pos - (before.lastIndexOf('\n') + 1);
  return { x: 10 + col * charW - flowSrc.scrollLeft, y: PAD_TOP + (row + 1) * LINE_H - flowSrc.scrollTop };
}

function renderSuggest() {
  if (!sug) { sugBox.hidden = true; flowSrc.setAttribute('aria-expanded', 'false'); return; }
  sugBox.textContent = '';
  sug.items.forEach((it, i) => {
    const o = el('div', 'opt');
    o.setAttribute('role', 'option');
    o.id = `sug-${i}`;
    o.setAttribute('aria-selected', i === sug.index);
    const lb = el('span', 'lb');
    const k = it.label.toLowerCase().indexOf(sug.prefix.toLowerCase());
    if (sug.prefix && k >= 0) {
      lb.append(it.label.slice(0, k), el('b', null, it.label.slice(k, k + sug.prefix.length)), it.label.slice(k + sug.prefix.length));
    } else lb.textContent = it.label;
    o.append(lb, el('span', 'kd', it.kind || ''));
    o.onmousedown = (e) => { e.preventDefault(); sug.index = i; acceptSuggestion(); };
    sugBox.append(o);
  });
  const cur = sug.items[sug.index];
  if (cur?.doc) sugBox.append(el('div', 'doc', cur.doc));
  const { x, y } = caretXY(sug.from);
  const code = flowSrc.parentElement;
  sugBox.hidden = false;
  const maxX = code.clientWidth - sugBox.offsetWidth - 4;
  sugBox.style.left = `${Math.max(0, Math.min(x, maxX))}px`;
  const below = y + 2 + sugBox.offsetHeight <= code.clientHeight;
  sugBox.style.top = below ? `${y + 2}px` : `${Math.max(0, y - LINE_H - sugBox.offsetHeight - 2)}px`;
  flowSrc.setAttribute('aria-expanded', 'true');
  flowSrc.setAttribute('aria-activedescendant', `sug-${sug.index}`);
  sugBox.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

function updateSuggest(force = false) {
  const s = computeSuggestions(force);
  if (s && sug && s.from === sug.from) s.index = Math.min(sug.index, s.items.length - 1);
  else if (s) s.index = 0;
  sug = s;
  renderSuggest();
}

function acceptSuggestion() {
  const it = sug.items[sug.index];
  let ins = it.insert;
  const caret = ins.indexOf('‸');
  ins = ins.replace('‸', '');
  const from = sug.from;
  flowSrc.focus();
  flowSrc.setSelectionRange(from, sug.to);
  document.execCommand('insertText', false, ins);       // keeps native undo
  if (caret >= 0) flowSrc.setSelectionRange(from + caret, from + caret);
  sug = null;
  renderSuggest();
  flowSrc.dispatchEvent(new Event('input'));
  // chain: after "exec: " offer methods, after a step name offer its value, etc.
  setTimeout(() => updateSuggest(false), 0);
}

flowSrc.addEventListener('keydown', (e) => {
  if (e.key === ' ' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); updateSuggest(true); return; }
  if (!sug) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = sug.items.length;
    sug.index = (sug.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    renderSuggest();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault(); e.stopImmediatePropagation(); acceptSuggestion();
  } else if (e.key === 'Escape') {
    e.preventDefault(); sug = null; renderSuggest();
  }
}, true);   // capture: runs before the editor's own Tab/Enter handlers
flowSrc.addEventListener('input', (e) => { if (e.isTrusted) updateSuggest(false); });
flowSrc.addEventListener('blur', () => setTimeout(() => { sug = null; renderSuggest(); }, 150));
flowSrc.addEventListener('click', () => { if (sug) updateSuggest(false); });
flowSrc.addEventListener('scroll', () => { if (sug) renderSuggest(); });

// ---------------------------------------------------------------- flow editor: live checking
const lintEl = $('#flow-lint');
let lintTimer = null, lintSeq = 0;
function scheduleLint() {
  clearTimeout(lintTimer);
  lintTimer = setTimeout(runLint, 600);
}
async function runLint() {
  const seq = ++lintSeq;
  const src = flowSrc.value;
  if (!src.trim()) { lintEl.textContent = ''; lintEl.className = 'lint'; return; }
  let res, err = null;
  try { res = await api('/api/flow/check', { source: src }); } catch (e) { err = e.data || { error: e.message }; }
  if (seq !== lintSeq || src !== flowSrc.value) return;          // stale
  if (flowStatus.classList.contains('running') || flowStatus.classList.contains('paused')) return;   // a run's marks
  for (const [ln, st] of Object.entries(lineMarks)) if (st === 'error' || st === 'warn') { delete lineMarks[ln]; }
  if (err) {
    if (err.line) lineMarks[err.line] = 'error';
    lintEl.className = 'lint err';
    lintEl.textContent = `✗ ${err.error}`;
    renderGutter();
    return;
  }
  // client-side: unknown Jade methods
  const warns = [];
  if (knownMethods) {
    src.split('\n').forEach((l, i) => {
      const code = splitComment(l)[0];
      for (const m of code.matchAll(/\b(?:method|exec):\s*["']?([A-Za-z_]\w*)/g)) {
        if (!knownMethods.has(m[1])) { warns.push(`line ${i + 1}: unknown Jade method "${m[1]}"`); lineMarks[i + 1] = 'warn'; }
      }
    });
  }
  renderGutter();
  lintEl.className = warns.length ? 'lint warn' : 'lint ok';
  lintEl.textContent = warns.length ? `⚠ ${warns.join(' · ')}` : `✓ valid · ${res.steps} step(s)`;
}
flowSrc.addEventListener('input', scheduleLint);
scheduleLint();

// initial tab (last, once everything above is defined)
showTab(location.hash.slice(1) || localStorage.getItem('jw-tab') || 'flow');
