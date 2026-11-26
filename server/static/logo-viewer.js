'use strict';

const $ = (sel) => document.querySelector(sel);
const select = $('#logo-select');
const canvas = $('#logo-canvas');
const ctx = canvas.getContext('2d');
let logoNames = [];
let jadeSource = null;
let decodedSize = null;

function showRevision(file) {
  const source = $('#logo-source');
  const revision = $('#logo-revision');
  const detail = $('#logo-source-detail');
  const warning = $('#logo-warning');
  source.hidden = !jadeSource;
  warning.hidden = true;
  warning.textContent = '';
  if (!jadeSource) return;
  const tag = jadeSource.tags?.length ? ` · tag ${jadeSource.tags.join(', ')}` : '';
  revision.textContent = `Branch ${jadeSource.branch || 'unknown'} · commit ${jadeSource.short}${tag}`;
  revision.title = `${jadeSource.commit}\n${jadeSource.subject || ''}`;
  detail.textContent = `${jadeSource.date || ''} · ${jadeSource.subject || ''}`;
  detail.title = jadeSource.commit;
  if (jadeSource.modified?.includes(file) || jadeSource.untracked?.includes(file)) {
    warning.hidden = false;
    warning.textContent = jadeSource.untracked.includes(file)
      ? 'This logo file is untracked in the Jade checkout.'
      : 'This logo file has local changes and differs from the displayed commit.';
  }
}

function updateZoom() {
  if (!decodedSize) return;
  const zoom = Number($('#logo-zoom').value) || 1;
  canvas.style.width = `${decodedSize.width * zoom}px`;
  canvas.style.height = `${decodedSize.height * zoom}px`;
}

async function openLogo(file) {
  if (!file) return;
  $('#logo-title').textContent = file;
  $('#logo-meta').textContent = 'Decoding compressed RGB565 image…';
  $('#logo-state').textContent = 'Loading…';
  $('#logo-state').className = 'muted small';
  showRevision(file);
  canvas.width = canvas.height = 0;
  canvas.style.width = canvas.style.height = '';
  decodedSize = null;
  try {
    const response = await fetch(`/api/logos/${encodeURIComponent(file)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not read this logo (${response.status}).`);
    if (!('DecompressionStream' in window)) throw new Error('This browser does not support zlib decompression.');
    // Jade assets use a zlib stream despite the .bin.gz suffix.
    const compressed = await response.blob();
    const unpacked = await new Response(compressed.stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
    const bytes = new Uint8Array(unpacked);
    if (bytes.length < 3) throw new Error('The decoded logo is shorter than its header.');
    const width = bytes[0];
    const byteLength = bytes[1] | (bytes[2] << 8);
    if (!width || byteLength === 0 || byteLength % 2 || byteLength !== bytes.length - 3) {
      throw new Error('The logo header or pixel data length is invalid.');
    }
    const pixels = byteLength / 2;
    if (pixels % width) throw new Error('Pixel data does not form complete image rows.');
    const height = pixels / width;
    canvas.width = width;
    canvas.height = height;
    const image = ctx.createImageData(width, height);
    for (let src = 3, dst = 0; src < bytes.length; src += 2, dst += 4) {
      const rgb565 = (bytes[src] << 8) | bytes[src + 1];
      const red = (rgb565 >> 11) & 0x1f;
      const green = (rgb565 >> 5) & 0x3f;
      const blue = rgb565 & 0x1f;
      image.data[dst] = (red << 3) | (red >> 2);
      image.data[dst + 1] = (green << 2) | (green >> 4);
      image.data[dst + 2] = (blue << 3) | (blue >> 2);
      image.data[dst + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    decodedSize = { width, height };
    updateZoom();
    $('#logo-meta').textContent = `${width} × ${height} px · RGB565 · ${(byteLength / 1024).toFixed(1)} KiB of pixel data`;
    $('#logo-state').textContent = '';
    $('#logo-state').className = 'muted small';
    if (location.hash.slice(1) !== file) history.replaceState(null, '', `#${encodeURIComponent(file)}`);
  } catch (error) {
    $('#logo-meta').textContent = error.message;
    $('#logo-state').textContent = 'Could not display logo';
    $('#logo-state').className = 'logo-error';
  }
}

$('#logo-zoom').onchange = updateZoom;
select.onchange = () => openLogo(select.value);

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
    if (initial) { select.value = initial; openLogo(initial); }
    else $('#logo-state').textContent = 'No .bin.gz files found in jade/logo/.';
  } catch (error) {
    select.textContent = '';
    select.append(new Option('cannot list logos', ''));
    $('#logo-state').textContent = error.message;
    $('#logo-state').className = 'logo-error';
  }
}

init();
