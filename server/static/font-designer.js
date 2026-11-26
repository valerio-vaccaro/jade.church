// Font designer: shows every glyph of a Jade firmware font (jade/main/fonts/*.c) as a table.
//
// The fonts are C byte arrays in the two formats the firmware draws (main/display.c):
//  - fixed width:  header [width, height, first char, count], then for each char `height`
//                  rows of ceil(width / 8) bytes, MSB first (print_char)
//  - proportional: header [0, height, 0, 0], then glyphs [code, y offset, width, height,
//                  x offset, x advance, bits...] with the bits packed across rows, MSB first,
//                  until a 0xFF code (get_char_ptr / print_proportional_char)
'use strict';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const hex2 = (n) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');

let current = null;   // { file, font, arr }: arr.bytes is edited in place, arr.orig is what was loaded
let source = null;    // what is open: { file, text, local: File | null }, for Reload and Download
let jadeInfo = null;  // the Jade checkout the fonts come from (commit, tag, local changes)
let fontsDir = 'jade/main/fonts';
let editing = -1;     // index of the glyph open in the editor
const MODIFIED_COLOR = '#e3b341';

// ---------------------------------------------------------------- C source → bytes
// Returns { name, bytes, orig, spans, comments: [{at, text}] }: `at` is how many bytes came
// before the comment, so a comment can be matched to the glyph it labels; spans[i] is where
// byte i is written in the source, so saving can rewrite just the bytes that changed.
function parseCArray(src) {
  const decl = /unsigned\s+char\s+(\w+)\s*\[[^\]]*\]\s*(?:PROGMEM\s*)?=\s*\{/.exec(src);
  if (!decl) throw new Error('no "unsigned char name[] = { … }" array found');
  const bytes = [], comments = [], spans = [];
  let lastSignificant = null;
  let i = decl.index + decl[0].length;
  const token = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|0[xX][0-9a-fA-F]+|\d+|,|\}|[^\s,}]+/y;
  for (;;) {
    token.lastIndex = i;
    const m = token.exec(src);
    if (!m) throw new Error('the array is not closed with "}"');
    const t = m[0];
    i = token.lastIndex;
    if (t === '}') break;
    if (t.startsWith('//')) comments.push({ at: bytes.length, text: t.slice(2).trim() });
    else if (t.startsWith('/*')) comments.push({ at: bytes.length, text: t.slice(2, -2).trim() });
    else if (/^(0[xX][0-9a-fA-F]+|\d+)$/.test(t)) {
      const v = Number(t);
      if (v > 255) throw new Error(`value ${t} does not fit in a byte`);
      bytes.push(v);
      spans.push({ start: m.index, end: token.lastIndex, text: t });
      lastSignificant = 'value';
    } else if (t === ',') lastSignificant = 'comma';
    else if (t.trim()) throw new Error(`unexpected "${t}" in the array`);
  }
  return { name: decl[1], bytes, orig: bytes.slice(), spans, comments, closeAt: i - 1,
           trailingComma: lastSignificant === 'comma', appended: [], addedGlyphs: new Set() };
}

// ---------------------------------------------------------------- bytes → glyphs
// Each glyph: { code, w, h, xOff, yOff, adv, px: Uint8Array(w*h), orig (px as loaded), label,
//               at (index of its first bitmap byte), packed (bits run across rows) }
function decodeFont(arr) {
  const b = arr.bytes, warnings = [];
  if (b.length < 4) throw new Error('shorter than the 4-byte font header');
  const labelAt = new Map();
  for (const c of arr.comments) if (c.text && !labelAt.has(c.at)) labelAt.set(c.at, c.text);
  const glyphs = [];

  if (b[0] !== 0) {
    // fixed width
    const [w, h, first, count] = b;
    const rowBytes = (w + 7) >> 3, size = rowBytes * h;
    if (!size) throw new Error('fixed-width font has zero-sized characters');
    const avail = Math.floor((b.length - 4) / size);
    const complete = b.length === 4 + avail * size;
    if (avail !== count && complete) warnings.push(`header says ${count} characters, the data holds ${avail}`);
    else if (avail < count) warnings.push(`header says ${count} characters, the data holds ${avail}`);
    else if (b.length !== 4 + count * size) {
      warnings.push(`${b.length - 4 - count * size} extra byte(s) after the last character`);
    }
    const repair = avail !== count && complete ? { available: avail } : null;
    const canAddCharacter = complete && avail < 255 && first + avail <= 255;
    for (let n = 0; n < Math.min(count, avail); n++) {
      const start = 4 + n * size, px = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const byte = b[start + y * rowBytes + (x >> 3)];
          px[y * w + x] = (byte >> (7 - (x & 7))) & 1;
        }
      }
      // symbol fonts label each glyph with a trailing comment, after its last byte
      glyphs.push({ code: first + n, w, h, xOff: 0, yOff: 0, adv: w, px, orig: px.slice(),
                    added: arr.addedGlyphs?.has(n) || false,
                    at: start, packed: false, label: labelAt.get(start + size) ?? null });
    }
    return { kind: 'fixed', width: w, height: h, first, count, glyphs, warnings, size: b.length,
             name: arr.name, avail, repair, canAddCharacter };
  }

  // proportional
  const height = b[1];
  let p = 4, ended = false;
  while (p < b.length) {
    const code = b[p];
    if (code === 0xFF) { ended = true; p++; break; }
    if (p + 6 > b.length) { warnings.push(`glyph ${hex2(code)} is cut short`); break; }
    const start = p;
    const yOff = b[p + 1], w = b[p + 2], h = b[p + 3];
    const rawX = b[p + 4];
    const xOff = rawX < 0x80 ? rawX : -(0xFF - rawX);       // as the firmware reads it
    const adv = b[p + 5];
    p += 6;
    const n = w ? Math.floor((w * h - 1) / 8) + 1 : 0;
    if (p + n > b.length) { warnings.push(`glyph ${hex2(code)} is missing bitmap bytes`); break; }
    const px = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) px[k] = (b[p + (k >> 3)] >> (7 - (k & 7))) & 1;
    const at = p;
    p += n;
    // proportional fonts label each glyph with a comment just before its record
    glyphs.push({ code, w, h, xOff, yOff, adv, px, orig: px.slice(), at, packed: true,
                  label: labelAt.get(start) ?? null });
  }
  if (!ended) warnings.push('no 0xFF terminator: the firmware would read past the end of the array');
  else if (p < b.length) warnings.push(`${b.length - p} byte(s) after the 0xFF terminator are never read`);
  const seen = new Set();
  for (const g of glyphs) {
    if (seen.has(g.code)) warnings.push(`character ${hex2(g.code)} is defined more than once: only the first is used`);
    seen.add(g.code);
  }
  return { kind: 'proportional', width: 0, height, glyphs, warnings, size: b.length, name: arr.name };
}

// ---------------------------------------------------------------- rendering
const charName = (code) => code === 0x20 ? 'space' : code > 0x20 && code < 0x7F ? String.fromCharCode(code) : null;

function cellGeometry(font) {
  // One cell size for the whole table, so the glyphs line up like on the device.
  let left = 0, right = 1, top = 0, bottom = font.height || 1;
  for (const g of font.glyphs) {
    left = Math.min(left, g.xOff);
    right = Math.max(right, g.xOff + g.w, g.adv);
    top = Math.min(top, g.yOff);
    bottom = Math.max(bottom, g.yOff + g.h);
  }
  return { ox: -left, oy: -top, w: right - left, h: bottom - top };
}

function zoomFor(cell) {
  const z = $('#fd-zoom').value;
  if (z !== 'auto') return Number(z);
  return Math.max(1, Math.min(10, Math.floor(64 / Math.max(cell.w, cell.h))));
}

const isModified = (g) => g.added || g.px.some((v, i) => v !== g.orig[i]);
const modifiedCount = () => current ? current.font.glyphs.filter(isModified).length : 0;
const hasByteChanges = () => !!current && current.arr.bytes.some((v, i) => v !== current.arr.orig[i]);
// edits not downloaded yet (a download counts as saving them)
const unsaved = () => !!current && current.arr.bytes.join() !== (current.savedBytes ?? current.arr.orig.join());

function drawGlyph(g, cell, z, opts, c = el('canvas')) {
  c.width = cell.w * z; c.height = cell.h * z;
  c.style.width = `${c.width}px`; c.style.height = `${c.height}px`;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0b0e11';
  ctx.fillRect(0, 0, c.width, c.height);
  if (opts.box) {
    // the advance (where the next character starts) and the glyph's own bitmap box
    ctx.fillStyle = '#18202a';
    ctx.fillRect(cell.ox * z, 0, g.adv * z, c.height);
    ctx.strokeStyle = '#3a4a5c';
    ctx.lineWidth = 1;
    if (g.w && g.h) ctx.strokeRect((cell.ox + g.xOff) * z + 0.5, (cell.oy + g.yOff) * z + 0.5, g.w * z - 1, g.h * z - 1);
  }
  ctx.fillStyle = isModified(g) ? MODIFIED_COLOR : '#3fb6a8';
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      if (g.px[y * g.w + x]) ctx.fillRect((cell.ox + g.xOff + x) * z, (cell.oy + g.yOff + y) * z, z, z);
    }
  }
  if (opts.grid && z >= 4) {
    ctx.strokeStyle = opts.gridColor || '#ffffff14';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < cell.w; x++) { ctx.moveTo(x * z + 0.5, 0); ctx.lineTo(x * z + 0.5, c.height); }
    for (let y = 1; y < cell.h; y++) { ctx.moveTo(0, y * z + 0.5); ctx.lineTo(c.width, y * z + 0.5); }
    ctx.stroke();
  }
  return c;
}

function render() {
  const table = $('#fd-table');
  table.textContent = '';
  if (!current) return;
  const { font, file } = current;
  $('#fd-info').hidden = false;
  $('#fd-title').textContent = `${file} · ${font.name}`;
  const meta = font.kind === 'fixed'
    ? [`fixed width ${font.width}×${font.height}`, `characters ${hex2(font.first)}–${hex2(font.first + font.count - 1)}`]
    : [`proportional, height ${font.height}`];
  meta.push(`${font.glyphs.length} glyph(s)`, `${font.size} bytes`);
  const mods = modifiedCount();
  if (mods) meta.push(`${mods} modified character${mods === 1 ? '' : 's'}`);
  if (hasByteChanges()) meta.push(unsaved() ? 'font modified, not downloaded' : 'font modified, downloaded');
  $('#fd-meta').textContent = meta.join(' · ');
  showBase();
  const warn = $('#fd-warn');
  warn.hidden = !font.warnings.length;
  warn.textContent = font.warnings.map((w) => `⚠ ${w}`).join('\n');
  const fixCount = $('#fd-fix-count');
  fixCount.hidden = !font.repair;
  fixCount.textContent = font.repair ? `Fix header count to ${font.repair.available}` : 'Fix header count';
  const addChar = $('#fd-add-char');
  addChar.hidden = font.kind !== 'fixed';
  addChar.disabled = !font.canAddCharacter;
  addChar.title = font.canAddCharacter
    ? 'Append one blank character to the data and update the header count'
    : 'No room to append a complete character to this font';
  if (!font.glyphs.length) {
    table.append(el('div', 'muted', 'This font has no glyphs.'));
    updateButtons();
    return;
  }

  const cell = cellGeometry(font), z = zoomFor(cell);
  const opts = { grid: $('#fd-grid').checked, box: $('#fd-box').checked };
  table.style.setProperty('--fd-cell', `${Math.max(cell.w * z, 56)}px`);
  font.glyphs.forEach((g, index) => {
    const card = el('figure', 'fd-glyph' + (isModified(g) ? ' modified' : ''));
    card.tabIndex = 0;
    card.onclick = () => openEditor(index);
    card.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditor(index); } };
    const name = charName(g.code);
    card.title = [`code ${g.code} (${hex2(g.code)})`, name && `character ${name === 'space' ? '" "' : name}`,
      g.label && `comment: ${g.label}`, `bitmap ${g.w}×${g.h}`,
      font.kind === 'proportional' && `x offset ${g.xOff}, y offset ${g.yOff}, advance ${g.adv}`]
      .filter(Boolean).concat('click to edit').join('\n');
    card.append(drawGlyph(g, cell, z, opts));
    const cap = el('figcaption');
    cap.append(el('span', 'fd-code', hex2(g.code)));
    if (name) cap.append(el('span', 'fd-char', name));
    // hide comments that only repeat the character, eg. // 'A', // <space>, // ' '
    const ch = String.fromCharCode(g.code);
    const label = g.label && ![name, `'${name}'`, `<${name}>`, `'${ch}'`, ch].includes(g.label) ? g.label : null;
    if (label) cap.append(el('span', 'fd-label', label));
    cap.append(el('span', 'fd-dims', font.kind === 'fixed' ? `${g.w}×${g.h}` : `${g.w}×${g.h} → ${g.adv}`));
    if (isModified(g)) cap.append(el('span', 'fd-mod', 'modified'));
    card.append(cap);
    table.append(card);
  });
  updateButtons();
}

// ---------------------------------------------------------------- editing
// Writes a glyph's pixels back into the font bytes, in the layout it was read from.
function encodeGlyph(g) {
  const b = current.arr.bytes;
  if (g.packed) {
    const n = g.w ? Math.floor((g.w * g.h - 1) / 8) + 1 : 0;
    for (let i = 0; i < n; i++) b[g.at + i] = 0;
    for (let k = 0; k < g.w * g.h; k++) if (g.px[k]) b[g.at + (k >> 3)] |= 0x80 >> (k & 7);
  } else {
    const rowBytes = (g.w + 7) >> 3;
    for (let i = 0; i < rowBytes * g.h; i++) b[g.at + i] = 0;
    for (let y = 0; y < g.h; y++) {
      for (let x = 0; x < g.w; x++) if (g.px[y * g.w + x]) b[g.at + y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  // bits the firmware never draws (row padding, the tail of the last byte) keep their original value
  const start = g.at, end = g.at + (g.packed ? (g.w ? Math.floor((g.w * g.h - 1) / 8) + 1 : 0) : ((g.w + 7) >> 3) * g.h);
  const used = new Uint8Array(end - start);
  if (g.packed) for (let k = 0; k < g.w * g.h; k++) used[k >> 3] |= 0x80 >> (k & 7);
  else for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) used[y * ((g.w + 7) >> 3) + (x >> 3)] |= 0x80 >> (x & 7);
  for (let i = start; i < end; i++) b[i] = (b[i] & used[i - start]) | (current.arr.orig[i] & ~used[i - start] & 0xFF);
}

// The source with the edited bytes written in place: same layout, comments and number style.
function buildSource() {
  const { arr } = current;
  let out = source.text;
  if (arr.appended.length) {
    const style = arr.spans.at(-1)?.text || '0x00';
    const format = (value) => {
      if (!/^0[xX]/.test(style)) return String(value);
      const digits = value.toString(16).padStart(style.length - 2, '0');
      return style.slice(0, 2) + (/[a-f]/.test(style.slice(2)) ? digits : digits.toUpperCase());
    };
    const charSize = ((current.font.width + 7) >> 3) * current.font.height;
    const lines = [];
    for (let i = 0; i < arr.appended.length; i += charSize) {
      lines.push(`  ${arr.appended.slice(i, i + charSize).map(format).join(', ')}, // added blank character`);
    }
    out = out.slice(0, arr.closeAt) + `${arr.trailingComma ? '' : ','}\n${lines.join('\n')}\n` + out.slice(arr.closeAt);
  }
  for (let i = arr.orig.length - 1; i >= 0; i--) {
    if (arr.bytes[i] === arr.orig[i]) continue;
    const { start, end, text } = arr.spans[i];
    let t;
    if (/^0[xX]/.test(text)) {
      const digits = arr.bytes[i].toString(16).padStart(text.length - 2, '0');
      t = text.slice(0, 2) + (/[a-f]/.test(text.slice(2)) ? digits : digits.toUpperCase());
    } else t = String(arr.bytes[i]);
    out = out.slice(0, start) + t + out.slice(end);
  }
  return out;
}

function fixHeaderCount() {
  if (!current || current.font.kind !== 'fixed' || !current.font.repair) return;
  current.arr.bytes[3] = current.font.repair.available;
  current.font = decodeFont(current.arr);
  render();
}

function addBlankCharacter() {
  if (!current || current.font.kind !== 'fixed' || !current.font.canAddCharacter) return;
  const { font } = current;
  const rowBytes = (font.width + 7) >> 3;
  const charSize = rowBytes * font.height;
  const index = font.avail;
  current.arr.bytes[3] = index + 1;
  current.arr.addedGlyphs.add(index);
  const blank = new Array(charSize).fill(0);
  current.arr.bytes.push(...blank);
  current.arr.appended.push(...blank);
  current.font = decodeFont(current.arr);
  render();
}

function editorGeometry(g) {
  const cell = cellGeometry(current.font);
  const z = Math.max(4, Math.min(32, Math.floor(Math.min(560 / cell.w, 420 / cell.h))));
  return { cell, z };
}

function drawEditor() {
  const g = current.font.glyphs[editing];
  const { cell, z } = editorGeometry(g);
  const canvas = $('#fd-ed-canvas');
  drawGlyph(g, cell, z, { grid: true, box: true, gridColor: '#ffffff22' }, canvas);
  drawGlyph(g, cell, 1, { box: false }, $('#fd-ed-small1'));
  drawGlyph(g, cell, 2, { box: false }, $('#fd-ed-small2'));
  const name = charName(g.code);
  $('#fd-ed-title').textContent = `${hex2(g.code)}${name ? ` ${name}` : ''}${g.label && g.label !== name ? ` · ${g.label}` : ''}`;
  $('#fd-ed-meta').textContent = [`glyph ${editing + 1} of ${current.font.glyphs.length}`, `bitmap ${g.w}×${g.h}`,
    current.font.kind === 'proportional' ? `x offset ${g.xOff}, y offset ${g.yOff}, advance ${g.adv}` : null,
    isModified(g) ? 'modified' : null].filter(Boolean).join(' · ');
  $('#fd-ed-meta').classList.toggle('modified', isModified(g));
  $('#fd-ed-revert').disabled = !isModified(g);
  $('#fd-ed-prev').disabled = editing <= 0;
  $('#fd-ed-next').disabled = editing >= current.font.glyphs.length - 1;
}

function openEditor(index) {
  if (!current) return;
  editing = index;
  drawEditor();
  const dlg = $('#fd-editor');
  if (!dlg.open) dlg.showModal();
}

function changed() {
  const g = current.font.glyphs[editing];
  encodeGlyph(g);
  drawEditor();
  render();
}

function setupEditor() {
  const canvas = $('#fd-ed-canvas');
  let paint = null;   // value being painted while the mouse is down
  const pixelAt = (e) => {
    const g = current.font.glyphs[editing];
    const { cell, z } = editorGeometry(g);
    const r = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) * (canvas.width / r.width) / z) - cell.ox - g.xOff;
    const y = Math.floor((e.clientY - r.top) * (canvas.height / r.height) / z) - cell.oy - g.yOff;
    return x >= 0 && y >= 0 && x < g.w && y < g.h ? y * g.w + x : -1;   // only the bitmap box can be drawn
  };
  canvas.onpointerdown = (e) => {
    const k = pixelAt(e);
    if (k < 0) return;
    const g = current.font.glyphs[editing];
    paint = g.px[k] ? 0 : 1;          // click toggles; dragging paints the same value
    g.px[k] = paint;
    canvas.setPointerCapture(e.pointerId);
    drawEditor();
  };
  canvas.onpointermove = (e) => {
    if (paint === null) return;
    const k = pixelAt(e), g = current.font.glyphs[editing];
    if (k >= 0 && g.px[k] !== paint) { g.px[k] = paint; drawEditor(); }
  };
  canvas.onpointerup = canvas.onpointercancel = () => {
    if (paint === null) return;
    paint = null;
    changed();
  };
  const edit = (fn) => () => { fn(current.font.glyphs[editing]); changed(); };
  $('#fd-ed-invert').onclick = edit((g) => { for (let k = 0; k < g.px.length; k++) g.px[k] ^= 1; });
  $('#fd-ed-clear').onclick = edit((g) => g.px.fill(0));
  $('#fd-ed-revert').onclick = edit((g) => g.px.set(g.orig));
  $('#fd-ed-prev').onclick = () => editing > 0 && openEditor(editing - 1);
  $('#fd-ed-next').onclick = () => editing < current.font.glyphs.length - 1 && openEditor(editing + 1);
  $('#fd-ed-close').onclick = () => $('#fd-editor').close();
  $('#fd-editor').onkeydown = (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); $('#fd-ed-prev').click(); }
    if (e.key === 'ArrowRight') { e.preventDefault(); $('#fd-ed-next').click(); }
  };
  // clicking the dark backdrop closes the editor
  $('#fd-editor').onclick = (e) => { if (e.target === $('#fd-editor')) $('#fd-editor').close(); };
}

// Edits live only in the page until downloaded: ask before throwing them away.
const confirmDiscard = () => !unsaved() ||
  confirm('Font changes have not been downloaded. Discard them?');

// Where the open font comes from: the Jade commit and tag, so you know which fonts you edit.
function showBase() {
  const box = $('#fd-base');
  const panel = $('#fd-source');
  box.textContent = '';
  box.className = 'fd-base';
  panel.hidden = !source;
  if (!source) return;
  if (source.local) {
    box.append(el('div', 'fd-source-path', `Opened from your computer · ${source.file}`),
      el('div', 'fd-source-subject', 'This file is not tied to a Jade commit.'));
    return;
  }
  if (!jadeInfo) {
    box.append(el('div', 'fd-source-path', `${fontsDir}/${source.file}`),
      el('div', 'fd-source-subject', 'Jade version unknown (not a git checkout).'));
    return;
  }
  const j = jadeInfo;
  const ver = j.tags.length ? `tag ${j.tags.join(', ')}` : `no tag on this commit (${j.describe})`;
  box.append(el('div', 'fd-source-path', `${fontsDir}/${source.file}`), 'Branch ' + (j.branch || 'detached HEAD') + ' · commit ');
  const c = el('code', null, j.short);
  c.title = `${j.commit}\n${j.subject}`;
  box.append(c, ` · ${ver}`,
    el('div', 'fd-source-subject', `${j.date} · ${j.subject}`));
  const name = source.file;
  if (j.modified.includes(name) || j.untracked.includes(name)) {
    box.classList.add('warn');
    box.append(el('div', 'fd-source-warning', j.untracked.includes(name)
      ? '⚠ this file is not in Jade\'s git history (new, untracked file)'
      : '⚠ this file has local changes in the Jade checkout: it differs from that commit'));
  }
}

// ---------------------------------------------------------------- loading
function load(file, src, local = null) {
  source = { file, text: src, local };
  showBase();
  updateButtons();
  try {
    const arr = parseCArray(src);
    current = { file, arr, font: decodeFont(arr) };
  } catch (e) {
    current = null;
    updateButtons();
    $('#fd-info').hidden = false;
    $('#fd-title').textContent = file;
    $('#fd-meta').textContent = '';
    $('#fd-warn').hidden = false;
    $('#fd-warn').textContent = `Cannot read this font: ${e.message}`;
    $('#fd-fix-count').hidden = true;
    $('#fd-add-char').hidden = true;
    $('#fd-table').textContent = '';
    return;
  }
  render();
}

function updateButtons() {
  $('#fd-reload').disabled = !source;
  $('#fd-download').disabled = !source || !source.text;
  const mods = modifiedCount(), changed = hasByteChanges();
  $('#fd-download').textContent = unsaved() ? '⬇ Download (modified)' : '⬇ Download';
  $('#fd-download').classList.toggle('modified', changed);
  $('#fd-download').title = changed
    ? `Download ${source.file} with ${mods} modified or added character(s) and any font repairs`
    : "Download the font's .c file";
  $('#fd-reload').title = source
    ? `Read ${source.file} again${source.local ? ' from disk' : ' from the server'}` : 'Open a font first';
}

async function reload() {
  if (!source || !confirmDiscard()) return;
  const y = window.scrollY;
  if (source.local) {
    try {
      load(source.file, await source.local.text(), source.local);
    } catch (e) {
      // browsers may refuse to re-read a file that changed after it was picked
      $('#fd-warn').hidden = false;
      $('#fd-warn').textContent = `Cannot read ${source.file} again (${e.message}): open it with "Open file…".`;
      return;
    }
  } else {
    try { jadeInfo = (await (await fetch('/api/fonts', { cache: 'no-store' })).json()).jade; } catch { /* keep the old one */ }
    await openServerFont(source.file);
  }
  window.scrollTo(0, y);
}

function download() {
  if (!source?.text) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([current ? buildSource() : source.text], { type: 'text/x-csrc' }));
  if (current) current.savedBytes = current.arr.bytes.join();
  a.download = source.file.split('/').pop() || 'font.c';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  if (current) render();
}

async function openServerFont(file) {
  if (!file) return;
  const res = await fetch(`/api/fonts/${encodeURIComponent(file)}`, { cache: 'no-store' });
  if (!res.ok) { load(file, ''); return; }
  load(file, await res.text());
  if (location.hash.slice(1) !== file) history.replaceState(null, '', `#${encodeURIComponent(file)}`);
}

async function init() {
  const sel = $('#fd-font');
  try {
    const res = await fetch('/api/fonts');
    const { dir, fonts, jade } = await res.json();
    jadeInfo = jade;
    fontsDir = dir;
    $('#fd-dir').textContent = `from ${dir}/` + (jade ? ` · Jade ${jade.tags[0] || jade.describe} (${jade.short})` : '');
    $('#fd-dir').title = jade ? `Jade commit ${jade.commit} (${jade.date})\n${jade.subject}` +
      (jade.modified.length ? `\nFonts with local changes: ${jade.modified.join(', ')}` : '') : '';
    sel.textContent = '';
    sel.append(new Option(fonts.length ? '— choose a font —' : 'no fonts found', ''));
    // fonts that differ from the Jade commit are marked in the list
    for (const f of fonts) sel.append(new Option(jade?.modified.includes(f) ? `${f} (locally modified)` : f, f));
    const wanted = decodeURIComponent(location.hash.slice(1));
    const initial = fonts.includes(wanted) ? wanted : fonts[0];
    if (initial) { sel.value = initial; openServerFont(initial); }
  } catch (e) {
    sel.textContent = '';
    sel.append(new Option('cannot list fonts', ''));
  }
  let shown = sel.value;
  sel.onchange = () => {
    if (!confirmDiscard()) { sel.value = shown; return; }
    shown = sel.value;
    openServerFont(sel.value);
  };
  $('#fd-open').onclick = () => confirmDiscard() && $('#fd-file').click();
  $('#fd-file').onchange = async () => {
    const f = $('#fd-file').files[0];
    if (!f) return;
    sel.value = shown = '';
    history.replaceState(null, '', location.pathname);
    load(f.name, await f.text(), f);
    $('#fd-file').value = '';
  };
  for (const id of ['#fd-zoom', '#fd-grid', '#fd-box']) $(id).onchange = render;
  $('#fd-reload').onclick = reload;
  $('#fd-download').onclick = download;
  $('#fd-fix-count').onclick = fixHeaderCount;
  $('#fd-add-char').onclick = addBlankCharacter;
  setupEditor();
  window.addEventListener('beforeunload', (e) => { if (unsaved()) e.preventDefault(); });
  updateButtons();
}

init();
