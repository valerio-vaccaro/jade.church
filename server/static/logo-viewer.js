'use strict';

const $ = (sel) => document.querySelector(sel);
const select = $('#logo-select');
const canvas = $('#logo-canvas');
const ctx = canvas.getContext('2d');
const editorCanvas = $('#logo-edit-canvas');
const editorCtx = editorCanvas.getContext('2d');
const editorDialog = $('#logo-editor-dialog');
const canvasStage = $('#logo-canvas-stage');
let logoNames = [];
let jadeSource = null;
let decodedSize = null;
let pixels = null;
let originalPixels = null;
let dirtyPixels = 0;
let currentLogo = '';
let loadSequence = 0;
let painting = false;
let paletteDirty = false;
let isNewImage = false;
let selectedAsset = '';
let currentSource = '';
let localFile = null;
let newImageSize = null;

function showRevision(file) {
  const source = $('#logo-source');
  const revision = $('#logo-revision');
  const detail = $('#logo-source-detail');
  const warning = $('#logo-warning');
  source.hidden = !jadeSource || !file;
  warning.hidden = true;
  warning.textContent = '';
  if (!jadeSource) return;
  const tag = jadeSource.tags?.length
    ? ` · tag ${jadeSource.tags.join(', ')}` : ` · no tag on this commit (${jadeSource.describe || jadeSource.short})`;
  const locallyChanged = jadeSource.modified?.includes(file) || jadeSource.untracked?.includes(file);
  revision.textContent = `Branch ${jadeSource.branch || 'unknown'} · last commit ${jadeSource.short}${tag}` +
    (locallyChanged ? ' · local modifications' : '');
  revision.title = `${jadeSource.commit}\n${jadeSource.subject || ''}`;
  detail.textContent = `${jadeSource.date || ''} · ${jadeSource.subject || ''}`;
  detail.title = jadeSource.commit;
  if (locallyChanged) {
    warning.hidden = false;
    warning.textContent = jadeSource.untracked.includes(file)
      ? 'This logo file is untracked in the Jade checkout.'
      : 'This logo file has local changes and differs from the displayed commit.';
  }
}

function updateEditState() {
  const changed = dirtyPixels > 0 || isNewImage;
  $('#logo-reset').disabled = dirtyPixels === 0;
  $('#logo-download').disabled = !changed;
  $('#logo-reload').disabled = !currentSource;
  $('#logo-state').className = changed ? 'logo-edited small' : 'muted small';
  $('#logo-state').textContent = isNewImage && !dirtyPixels
    ? 'New blank image · download to export'
    : dirtyPixels
      ? `${dirtyPixels} pixel${dirtyPixels === 1 ? '' : 's'} modified · download to export`
      : '';
}

function drawPreview() {
  if (!pixels || !decodedSize) return;
  const image = ctx.createImageData(decodedSize.width, decodedSize.height);
  for (let i = 0, j = 0; i < pixels.length; i++, j += 4) {
    const rgb565 = pixels[i];
    const red = (rgb565 >> 11) & 0x1f;
    const green = (rgb565 >> 5) & 0x3f;
    const blue = rgb565 & 0x1f;
    image.data[j] = (red << 3) | (red >> 2);
    image.data[j + 1] = (green << 2) | (green >> 4);
    image.data[j + 2] = (blue << 3) | (blue >> 2);
    image.data[j + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

function updatePreviewSize() {
  if (!decodedSize) return;
  const zoom = currentZoom();
  const width = decodedSize.width * zoom, height = decodedSize.height * zoom;
  canvasStage.style.width = `${width}px`;
  canvasStage.style.height = `${height}px`;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
}

function updateZoom() {
  if (!decodedSize) return;
  drawPreview();
  updatePreviewSize();
}

function currentZoom() {
  const selected = $('#logo-zoom').value;
  if (selected !== 'auto') return Number(selected) || 1;
  if (!decodedSize) return 1;
  const wrap = $('.logo-canvas-wrap');
  const availableWidth = Math.max(1, wrap.clientWidth - 52);
  const availableHeight = Math.max(1, Math.min(wrap.clientHeight, window.innerHeight * 0.68) - 52);
  // Auto means fit the whole image in the preview, including logos larger than
  // the available area. Fractional CSS scaling is fine here; editing remains
  // pixel-for-pixel in the dedicated editor.
  return Math.max(0.1, Math.min(32,
    availableWidth / decodedSize.width, availableHeight / decodedSize.height));
}

function drawEditor() {
  if (!pixels || !decodedSize) return;
  const { width, height } = decodedSize;
  const zoom = Math.max(4, Math.min(32, Math.floor(Math.min(900 / width, 620 / height))));
  editorCanvas.width = width * zoom;
  editorCanvas.height = height * zoom;
  editorCanvas.style.width = `${editorCanvas.width}px`;
  editorCanvas.style.height = `${editorCanvas.height}px`;
  const colors = new Map();
  for (let i = 0; i < pixels.length; i++) {
    const color = pixels[i];
    if (!colors.has(color)) colors.set(color, color565ToHex(color));
    editorCtx.fillStyle = colors.get(color);
    editorCtx.fillRect((i % width) * zoom, Math.floor(i / width) * zoom, zoom, zoom);
  }
  editorCtx.beginPath();
  editorCtx.lineWidth = 1;
  editorCtx.strokeStyle = '#ffffff33';
  editorCtx.shadowColor = '#000';
  editorCtx.shadowBlur = 1;
  for (let x = 1; x < width; x++) {
    editorCtx.moveTo(x * zoom + 0.5, 0); editorCtx.lineTo(x * zoom + 0.5, editorCanvas.height);
  }
  for (let y = 1; y < height; y++) {
    editorCtx.moveTo(0, y * zoom + 0.5); editorCtx.lineTo(editorCanvas.width, y * zoom + 0.5);
  }
  editorCtx.stroke();
  $('#logo-editor-title').textContent = currentLogo;
  $('#logo-editor-meta').textContent = `${width} × ${height} px · ${zoom}× · RGB565`;
}

function colorTo565(hex) {
  const red = parseInt(hex.slice(1, 3), 16);
  const green = parseInt(hex.slice(3, 5), 16);
  const blue = parseInt(hex.slice(5, 7), 16);
  return ((red >> 3) << 11) | ((green >> 2) << 5) | (blue >> 3);
}

function color565ToHex(rgb565) {
  const red5 = (rgb565 >> 11) & 0x1f, green6 = (rgb565 >> 5) & 0x3f, blue5 = rgb565 & 0x1f;
  const values = [(red5 << 3) | (red5 >> 2), (green6 << 2) | (green6 >> 4), (blue5 << 3) | (blue5 >> 2)];
  return `#${values.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function updatePaletteSelection() {
  const selected = colorTo565($('#logo-brush').value);
  for (const palette of [$('#logo-palette'), $('#logo-editor-palette')]) {
    for (const swatch of palette.children) {
      const active = Number(swatch.dataset.rgb565) === selected;
      swatch.classList.toggle('selected', active);
      swatch.setAttribute('aria-pressed', String(active));
    }
  }
}

function renderPalette() {
  if (!pixels) return;
  const counts = new Map();
  for (const color of pixels) counts.set(color, (counts.get(color) || 0) + 1);
  const colors = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 16);
  const palettes = [$('#logo-palette'), $('#logo-editor-palette')];
  for (const palette of palettes) palette.textContent = '';
  for (const [color, count] of colors) {
    const hex = color565ToHex(color);
    for (const palette of palettes) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'logo-swatch';
      swatch.dataset.rgb565 = String(color);
      swatch.style.backgroundColor = hex;
      swatch.title = `${hex} · ${count.toLocaleString()} pixel${count === 1 ? '' : 's'}`;
      swatch.setAttribute('aria-label', `Use ${hex}, ${count} pixels`);
      swatch.onclick = () => {
        $('#logo-brush').value = hex;
        updatePaletteSelection();
      };
      palette.append(swatch);
    }
  }
  paletteDirty = false;
  updatePaletteSelection();
}

function paintAt(event) {
  if (!pixels || !decodedSize) return;
  const rect = editorCanvas.getBoundingClientRect();
  const x = Math.floor((event.clientX - rect.left) * decodedSize.width / rect.width);
  const y = Math.floor((event.clientY - rect.top) * decodedSize.height / rect.height);
  if (x < 0 || y < 0 || x >= decodedSize.width || y >= decodedSize.height) return;
  const index = y * decodedSize.width + x;
  const old = pixels[index], next = colorTo565($('#logo-brush').value);
  if (old === next) return;
  const wasDirty = old !== originalPixels[index];
  const isDirty = next !== originalPixels[index];
  if (wasDirty !== isDirty) dirtyPixels += isDirty ? 1 : -1;
  pixels[index] = next;
  paletteDirty = true;
  drawPreview();
  drawEditor();
  updateEditState();
}

function beginLogoLoad(file, sourceType) {
  const sequence = ++loadSequence;
  currentLogo = file;
  currentSource = sourceType;
  selectedAsset = sourceType === 'server' ? file : '';
  isNewImage = sourceType === 'new';
  dirtyPixels = 0;
  pixels = originalPixels = null;
  decodedSize = null;
  $('#logo-title').textContent = file;
  $('#logo-meta').textContent = 'Decoding compressed RGB565 image…';
  $('#logo-state').textContent = 'Loading…';
  $('#logo-state').className = 'muted small';
  $('#logo-palette').textContent = '';
  paletteDirty = false;
  showRevision(sourceType === 'server' ? file : '');
  canvas.width = canvas.height = 0;
  canvas.style.width = canvas.style.height = '';
  canvasStage.style.width = canvasStage.style.height = '';
  updateEditState();
  return sequence;
}

async function decompressLogo(blob) {
  if (!('DecompressionStream' in window)) throw new Error('This browser does not support zlib decompression.');
  // Jade assets use a zlib stream despite the .bin.gz suffix.
  const stream = blob.stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function displayLogo(file, bytes, sourceType) {
  if (bytes.length < 3) throw new Error('The decoded logo is shorter than its header.');
  const width = bytes[0];
  const byteLength = bytes[1] | (bytes[2] << 8);
  if (!width || byteLength === 0 || byteLength % 2 || byteLength !== bytes.length - 3) {
    throw new Error('The logo header or pixel data length is invalid.');
  }
  const pixelCount = byteLength / 2;
  if (pixelCount % width) throw new Error('Pixel data does not form complete image rows.');
  const height = pixelCount / width;
  pixels = new Uint16Array(pixelCount);
  for (let src = 3, dst = 0; src < bytes.length; src += 2, dst++) {
    pixels[dst] = (bytes[src] << 8) | bytes[src + 1];
  }
  originalPixels = pixels.slice();
  decodedSize = { width, height };
  canvas.width = width;
  canvas.height = height;
  updateZoom();
  $('#logo-meta').textContent = `${width} × ${height} px · RGB565 · ${(byteLength / 1024).toFixed(1)} KiB of pixel data` +
    (sourceType === 'local' ? ' · opened from your computer' : '');
  updateEditState();
  renderPalette();
  if (sourceType === 'server' && location.hash.slice(1) !== file) history.replaceState(null, '', `#${encodeURIComponent(file)}`);
}

async function openLogo(file) {
  if (!file) return;
  localFile = null;
  newImageSize = null;
  const sequence = beginLogoLoad(file, 'server');
  try {
    const response = await fetch(`/api/logos/${encodeURIComponent(file)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not read this logo (${response.status}).`);
    const bytes = await decompressLogo(await response.blob());
    if (sequence !== loadSequence) return;
    displayLogo(file, bytes, 'server');
  } catch (error) {
    if (sequence !== loadSequence) return;
    $('#logo-meta').textContent = error.message;
    $('#logo-state').textContent = 'Could not display logo';
    $('#logo-state').className = 'logo-error';
  }
}

async function openLocalLogo(file) {
  if (!file) return;
  localFile = file;
  newImageSize = null;
  select.value = '';
  const sequence = beginLogoLoad(file.name, 'local');
  try {
    const bytes = await decompressLogo(new Blob([await file.arrayBuffer()]));
    if (sequence !== loadSequence) return;
    displayLogo(file.name, bytes, 'local');
    history.replaceState(null, '', location.pathname);
  } catch (error) {
    if (sequence !== loadSequence) return;
    $('#logo-meta').textContent = error.message;
    $('#logo-state').textContent = 'Could not display logo';
    $('#logo-state').className = 'logo-error';
  }
}

async function downloadEditedLogo() {
  if (!pixels || !decodedSize || (!dirtyPixels && !isNewImage)) return;
  if (!('CompressionStream' in window)) {
    $('#logo-state').textContent = 'This browser does not support zlib compression.';
    $('#logo-state').className = 'logo-error';
    return;
  }
  const byteLength = pixels.length * 2;
  if (byteLength > 0xffff) {
    $('#logo-state').textContent = 'This image is too large for the Jade logo format.';
    $('#logo-state').className = 'logo-error';
    return;
  }
  const raw = new Uint8Array(3 + byteLength);
  raw[0] = decodedSize.width;
  raw[1] = byteLength & 0xff;
  raw[2] = byteLength >> 8;
  for (let i = 0, dst = 3; i < pixels.length; i++, dst += 2) {
    raw[dst] = pixels[i] >> 8;
    raw[dst + 1] = pixels[i] & 0xff;
  }
  try {
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
    const compressed = await new Response(stream).blob();
    const url = URL.createObjectURL(compressed);
    const link = document.createElement('a');
    link.href = url;
    link.download = isNewImage ? currentLogo : currentLogo.replace(/\.bin\.gz$/i, '') + '-edited.bin.gz';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('#logo-state').textContent = isNewImage
      ? dirtyPixels ? `New image · ${dirtyPixels} pixel${dirtyPixels === 1 ? '' : 's'} modified · downloaded` : 'New blank image downloaded'
      : `${dirtyPixels} pixel${dirtyPixels === 1 ? '' : 's'} modified · downloaded`;
    $('#logo-state').className = 'logo-edited small';
  } catch (error) {
    $('#logo-state').textContent = `Could not compress image: ${error.message}`;
    $('#logo-state').className = 'logo-error';
  }
}

$('#logo-zoom').onchange = updateZoom;
$('#logo-brush').oninput = updatePaletteSelection;
$('#logo-open').onclick = () => $('#logo-file').click();
$('#logo-file').onchange = () => {
  const file = $('#logo-file').files[0];
  if (!file) return;
  if ((dirtyPixels || isNewImage) && !confirm('Discard the unsaved logo edits?')) {
    $('#logo-file').value = '';
    return;
  }
  openLocalLogo(file);
  $('#logo-file').value = '';
};
$('#logo-reload').onclick = () => {
  if (!currentSource) return;
  if ((dirtyPixels || isNewImage) && !confirm('Discard the unsaved logo edits and reload?')) return;
  if (currentSource === 'server') openLogo(currentLogo);
  else if (currentSource === 'local' && localFile) openLocalLogo(localFile);
  else if (currentSource === 'new' && newImageSize) createBlankLogo(newImageSize.width, newImageSize.height);
};
select.onchange = () => {
  const next = select.value;
  if (!next) { select.value = selectedAsset; return; }
  if ((dirtyPixels || isNewImage) && !confirm('Discard the unsaved logo edits?')) {
    select.value = selectedAsset;
    return;
  }
  openLogo(next);
};
$('#logo-reset').onclick = () => {
  if (!originalPixels) return;
  pixels = originalPixels.slice();
  dirtyPixels = 0;
  drawPreview();
  drawEditor();
  updateEditState();
  renderPalette();
};
$('#logo-download').onclick = downloadEditedLogo;
canvas.onclick = () => {
  if (!pixels) return;
  drawEditor();
  editorDialog.showModal();
};
canvas.onkeydown = (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && pixels) {
    event.preventDefault();
    canvas.click();
  }
};
$('#logo-editor-close').onclick = () => editorDialog.close();
editorCanvas.addEventListener('pointerdown', (event) => {
  if (!pixels) return;
  event.preventDefault();
  painting = true;
  editorCanvas.setPointerCapture(event.pointerId);
  paintAt(event);
});
editorCanvas.addEventListener('pointermove', (event) => { if (painting) paintAt(event); });
editorCanvas.addEventListener('pointerup', () => {
  painting = false;
  if (paletteDirty) renderPalette();
});
editorCanvas.addEventListener('pointercancel', () => {
  painting = false;
  if (paletteDirty) renderPalette();
});
window.addEventListener('resize', () => { if ($('#logo-zoom').value === 'auto') updateZoom(); });
window.addEventListener('beforeunload', (event) => {
  if (dirtyPixels || isNewImage) { event.preventDefault(); event.returnValue = ''; }
});

const newDialog = $('#logo-new-dialog');
const newWidth = $('#logo-new-width'), newHeight = $('#logo-new-height');
function updateNewImageHeightLimit() {
  const width = Math.max(1, Number(newWidth.value) || 1);
  const maxHeight = Math.floor(0xffff / (2 * width));
  newHeight.max = String(maxHeight);
  if (Number(newHeight.value) > maxHeight) newHeight.value = String(maxHeight);
}
$('#logo-new').onclick = () => {
  $('#logo-new-error').hidden = true;
  updateNewImageHeightLimit();
  newDialog.showModal();
};
$('#logo-new-cancel').onclick = () => newDialog.close();
newWidth.oninput = updateNewImageHeightLimit;
function createBlankLogo(width, height) {
  ++loadSequence;
  localFile = null;
  currentSource = 'new';
  newImageSize = { width, height };
  currentLogo = `new-logo-${width}x${height}.bin.gz`;
  selectedAsset = '';
  select.value = '';
  isNewImage = true;
  decodedSize = { width, height };
  pixels = new Uint16Array(width * height);
  originalPixels = pixels.slice();
  dirtyPixels = 0;
  paletteDirty = false;
  showRevision('');
  $('#logo-title').textContent = `New image · ${width} × ${height}`;
  $('#logo-meta').textContent = `${width} × ${height} px · RGB565 · blank image`;
  canvas.width = width;
  canvas.height = height;
  updateZoom();
  updateEditState();
  renderPalette();
  history.replaceState(null, '', location.pathname);
}
$('#logo-new-form').onsubmit = (event) => {
  event.preventDefault();
  const width = Number(newWidth.value), height = Number(newHeight.value);
  const error = $('#logo-new-error');
  error.hidden = true;
  if (!Number.isInteger(width) || width < 1 || width > 240 ||
      !Number.isInteger(height) || height < 1 || width * height * 2 > 0xffff) {
    error.textContent = 'Choose a width from 1 to 240 pixels and a height that fits the Jade logo format.';
    error.hidden = false;
    return;
  }
  if ((dirtyPixels || isNewImage) && !confirm('Discard the unsaved logo edits?')) return;
  createBlankLogo(width, height);
  newDialog.close();
};

async function init() {
  try {
    const response = await fetch('/api/logos', { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not list logo assets.');
    const data = await response.json();
    logoNames = data.logos || [];
    jadeSource = data.jade || null;
    $('#logo-dir').textContent = `from ${data.dir || 'jade/logo'}/`;
    $('#logo-dir').title = jadeSource
      ? `Jade branch ${jadeSource.branch}\nCommit ${jadeSource.commit}\n${jadeSource.subject || ''}` : '';
    select.textContent = '';
    select.append(new Option(logoNames.length ? '— choose a logo —' : 'no logos found', ''));
    for (const name of logoNames) {
      const changed = jadeSource?.modified?.includes(name) || jadeSource?.untracked?.includes(name);
      select.append(new Option(changed ? `${name} · locally changed` : name, name));
    }
    const wanted = decodeURIComponent(location.hash.slice(1));
    const initial = logoNames.includes(wanted) ? wanted : logoNames[0];
    if (initial) { select.value = initial; selectedAsset = initial; openLogo(initial); }
    else $('#logo-state').textContent = 'No .bin.gz files found in jade/logo/.';
  } catch (error) {
    select.textContent = '';
    select.append(new Option('cannot list logos', ''));
    $('#logo-state').textContent = error.message;
    $('#logo-state').className = 'logo-error';
  }
}

init();
