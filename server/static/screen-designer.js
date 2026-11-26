// Screen designer: compose a Jade screen from the firmware's gui library (jade/main/gui.h),
// preview it pixel by pixel the way gui.c + display.c draw it, and generate the C code.
//
// Rendering follows the firmware:
//  - gui.c render_*: a node's rectangle is shrunk by margins, then borders, then padding;
//    splits divide the padded area (relative values are size * v / 100, rounded down);
//    fill/button/icon/picture/qrguide draw only their first child.
//  - display.c display_fill_rect / display_print_in_area / display_picture: same clipping,
//    alignment and wrapping rules, with the real fonts from jade/main/fonts/*.c.
'use strict';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// ---------------------------------------------------------------- firmware constants
const DEVICES = {
  v1: { w: 240, h: 135, label: 'Jade v1 (CONFIG_BOARD_TYPE_JADE_V1_ANY)' },
  v2: { w: 320, h: 170, label: 'Jade v2 (CONFIG_BOARD_TYPE_JADE_V2_ANY)' },
};
const CENTER = -9003, RIGHT = -9004, BOTTOM = -9004;   // display.h
const FILL_REMAINING = 'fill';                          // GUI_SPLIT_FILL_REMAINING (0xFF)

// color_t constants exactly as the firmware writes them (byte-swapped RGB565)
const NAMED_COLORS = [
  ['TFT_BLACK', 0x0000], ['TFT_WHITE', 0xFFFF], ['TFT_LIGHTGREY', 0x18C6], ['TFT_DARKGREY', 0xEF7B],
  ['TFT_RED', 0x00F8], ['TFT_GREEN', 0xE007], ['TFT_BLUE', 0x1F00], ['TFT_YELLOW', 0xE0FF],
  ['TFT_ORANGE', 0x20FD], ['TFT_CYAN', 0xFF07], ['TFT_MAGENTA', 0x1FF8], ['TFT_PINK', 0x19FE],
  ['TFT_NAVY', 0x0F00], ['TFT_DARKGREEN', 0xE003], ['TFT_DARKCYAN', 0xEF03], ['TFT_MAROON', 0x0078],
  ['TFT_PURPLE', 0x0F78], ['TFT_OLIVE', 0xE07B], ['TFT_GREENYELLOW', 0xE5AF],
  ['GUI_BLOCKSTREAM_JADE_GREEN', 0x4C04], ['GUI_BLOCKSTREAM_BUTTONBORDER_GREY', 0x0421],
  ['GUI_BLOCKSTREAM_HIGHTLIGHT_ORANGE', 0xE0D3], ['GUI_BLOCKSTREAM_HIGHTLIGHT_BLUE', 0xD318],
  ['GUI_BLOCKSTREAM_HIGHTLIGHT_DARKGREY', 0xA210], ['GUI_BLOCKSTREAM_HIGHTLIGHT_LIGHTGREY', 0xB294],
  ['GUI_BLOCKSTREAM_UNHIGHTLIGHTED_DEFAULT', 0x494A],
];
const COLOR_BY_NAME = new Map(NAMED_COLORS);
const THEMES = [0x4C04, 0xE0D3, 0xD318, 0xA210, 0xB294];       // gui_set_highlight_color()
const QR_COLORS = [0xa210, 0x494a, 0xef7b, 0x18c6, 0xffff];     // gui_qrcode_colors[]
const HIGHLIGHT = 'HIGHLIGHT';                                  // gui_get_highlight_color()

// display.h font ids → jade/main/fonts files (display_set_font)
const FONTS = [
  ['GUI_DEFAULT_FONT', 'DejaVuSans18.c', 'default body font (DejaVu Sans 18)'],
  ['GUI_TITLE_FONT', 'Ubuntu16.c', 'default title font (Ubuntu 16)'],
  ['DEFAULT_FONT', 'DefaultFont.c'], ['DEJAVU18_FONT', 'DejaVuSans18.c'], ['DEJAVU24_FONT', 'DejaVuSans24.c'],
  ['UBUNTU16_FONT', 'Ubuntu16.c'], ['COMIC24_FONT', 'comic24.c'], ['MINYA24_FONT', 'minya24.c'],
  ['TOONEY32_FONT', 'tooney32.c'], ['SMALL_FONT', 'SmallFont.c'], ['DEF_SMALL_FONT', 'def_small.c'],
  ['BIG_FONT', 'BigFont.c'], ['SINCLAIR_M', 'Sinclair_M.c'], ['SINCLAIR_S', 'Sinclair_S.c'],
  ['RETRO_8X16', 'Retro8x16.c'], ['VARIOUS_SYMBOLS_FONT', 'various_symbols.c'],
  ['VARIOUS_SYMBOLS_32_FONT', 'Various_Symbols_32x32.c'], ['BATTERY_FONT', 'battery_24x48.c'],
  ['JADE_SYMBOLS_16x16_FONT', 'jade_symbols_16x16.c'], ['JADE_SYMBOLS_16x32_FONT', 'jade_symbols_16x32.c'],
  ['JADE_SYMBOLS_24x24_FONT', 'jade_symbols_24x24.c'],
];
const FONT_FILE = new Map(FONTS.map(([id, file]) => [id, file]));
const SYMBOL_FONTS = new Set(['VARIOUS_SYMBOLS_FONT', 'VARIOUS_SYMBOLS_32_FONT', 'BATTERY_FONT',
  'JADE_SYMBOLS_16x16_FONT', 'JADE_SYMBOLS_16x32_FONT', 'JADE_SYMBOLS_24x24_FONT']);

const DEFAULT_EVENTS = ['BTN_BACK', 'BTN_HELP', 'BTN_YES', 'BTN_NO', 'BTN_EVENT_TIMEOUT'];

const BORDER_SIDES = [['TOP', 1], ['RIGHT', 2], ['BOTTOM', 4], ['LEFT', 8]];
const BORDER_NAMES = [[15, 'GUI_BORDER_ALL'], [10, 'GUI_BORDER_SIDES'], [5, 'GUI_BORDER_TOPBOTTOM'],
  [9, 'GUI_BORDER_TOPLEFT'], [3, 'GUI_BORDER_TOPRIGHT'], [1, 'GUI_BORDER_TOP'], [2, 'GUI_BORDER_RIGHT'],
  [4, 'GUI_BORDER_BOTTOM'], [8, 'GUI_BORDER_LEFT']];

// ---------------------------------------------------------------- node descriptions
const KINDS = {
  root: { label: 'root_node', maxChildren: 1, help: 'The activity\'s root node: a black fill covering the whole activity area. Like any fill it draws only its first child, so put a split here to lay out several things.' },
  vsplit: { label: 'vsplit', maxChildren: Infinity, fn: 'gui_make_vsplit',
    help: 'Divides its area into horizontal bands, top to bottom: one part per child. Values are percentages of the height (relative) or pixels (absolute); "fill" takes what is left. It paints nothing itself, so an empty vsplit is a spacer.' },
  hsplit: { label: 'hsplit', maxChildren: Infinity, fn: 'gui_make_hsplit',
    help: 'Divides its area into vertical columns, left to right: one part per child. Values are percentages of the width (relative) or pixels (absolute); "fill" takes what is left.' },
  fill: { label: 'fill', maxChildren: 1, fn: 'gui_make_fill',
    help: 'Paints a solid rectangle (plain colour, the theme highlight colour, or the QR background colour), then draws its one child on top. Use it as a background, or behind a text that will be updated.' },
  button: { label: 'button', maxChildren: 1, fn: 'gui_make_button',
    help: 'The only selectable node. Paints its colour (or its selected colour while selected), then its one child, usually a text. Clicking it posts GUI_BUTTON_EVENT with its event id. Buttons cannot be nested inside buttons.' },
  text: { label: 'text', maxChildren: 0, fn: 'gui_make_text_font',
    help: 'A string in one of the firmware fonts, aligned in its area. It wraps at the right edge (or scrolls on one line, with scroll on). Lines that do not fit vertically are not drawn. Up to 255 characters; \\n starts a new line.' },
  picture: { label: 'picture', maxChildren: 1, fn: 'gui_make_picture',
    help: 'An RGB565 image from jade/logo (a .bin.gz embedded in the firmware), aligned in its area. It must fit on the display: the firmware asserts otherwise.' },
  qrguide: { label: 'qrguide', maxChildren: 1, fn: 'gui_make_qrguide',
    help: 'The four corner brackets shown over the camera image when scanning a QR code, drawn in the biggest square that fits its area.' },
};

// ---------------------------------------------------------------- the design
let nextId = 1;
function makeNode(kind, props = {}, children = []) {
  const n = { id: nextId++, kind, name: '', margins: [0, 0, 0, 0], padding: [0, 0, 0, 0], border: null, children: [] };
  switch (kind) {
    case 'root': Object.assign(n, { color: 'TFT_BLACK' }); break;
    case 'vsplit': case 'hsplit': Object.assign(n, { splitKind: 'relative', values: [] }); break;
    case 'fill': Object.assign(n, { color: 'TFT_BLACK', selectedColor: null, fillType: 'plain' }); break;
    case 'button': Object.assign(n, { color: 'TFT_BLACK', selectedColor: HIGHLIGHT, event: 'BTN_YES', active: true, initial: false }); break;
    case 'text': Object.assign(n, { text: 'Text', font: 'GUI_DEFAULT_FONT', color: 'TFT_WHITE', selectedColor: null,
      halign: 'center', valign: 'middle', scroll: false, scrollBg: 'TFT_BLACK' }); break;
    case 'picture': Object.assign(n, { logo: 'ce.bin.gz', halign: 'center', valign: 'middle' }); break;
    case 'qrguide': Object.assign(n, { color: 'TFT_WHITE' }); break;
  }
  Object.assign(n, props);
  for (const c of children) n.children.push(c);
  if ((kind === 'vsplit' || kind === 'hsplit') && !props.values) n.values = evenSplit(n.children.length);
  return n;
}

function evenSplit(n) {     // make_even_split() in ui/dialogs.c, then an even fallback
  const table = { 1: [100], 2: [50, 50], 3: [33, 34, 33], 4: [25, 25, 25, 25], 5: [20, 20, 20, 20, 20],
    6: [17, 16, 17, 17, 16, 17], 7: [14, 15, 14, 14, 14, 15, 14] };
  if (!n) return [];
  return table[n] ? table[n].slice() : Array.from({ length: n }, () => Math.floor(100 / n));
}

const border = (color, thickness, sides, extra = {}) => ({ color, selected: null, inactive: null, thickness, sides, ...extra });
const text = (t, props = {}) => makeNode('text', { text: t, ...props });
const vsplit = (values, children, props = {}) => makeNode('vsplit', { values, ...props }, children);
const hsplit = (values, children, props = {}) => makeNode('hsplit', { values, ...props }, children);
const spacer = () => makeNode('vsplit', { values: [100], name: '' });

// add_button(): black button, highlight when selected, 1px border (grey if asked, else black)
function stdButton(label, event, borders = 0, props = {}) {
  const font = props.font || 'GUI_DEFAULT_FONT';
  return makeNode('button', { event, border: borders ? border('GUI_BLOCKSTREAM_BUTTONBORDER_GREY', 1, borders) : border('TFT_BLACK', 1, 15) },
    [text(label, { font })]);
}
function titleBar(title, withButtons = true) {
  const t = text(title, { font: 'GUI_TITLE_FONT' });
  if (!withButtons) return t;
  return hsplit([15, 70, 15], [
    stdButton('=', 'BTN_BACK', 15, { font: 'JADE_SYMBOLS_16x16_FONT' }),
    t,
    stdButton('?', 'BTN_HELP', 15),
  ]);
}

// building blocks: subtrees made the way the ui.h helpers make them
const BLOCKS = [
  { id: 'titled', label: 'Title bar + body', note: 'add_title_bar(): top 20% title, back/help buttons',
    make: () => vsplit([20, 80], [titleBar('Title'), spacer()]) },
  { id: 'titleonly', label: 'Title bar (text only)', note: 'add_title_bar() without buttons',
    make: () => vsplit([20, 80], [titleBar('Title', false), spacer()]) },
  { id: 'row2', label: 'Button row (2)', note: 'add_buttons(UI_ROW): [ No | Yes ]',
    make: () => hsplit([50, 50], [stdButton('No', 'BTN_NO', 15), stdButton('Yes', 'BTN_YES', 15)]) },
  { id: 'row3', label: 'Button row (3)', note: 'add_buttons(UI_ROW) with 3 buttons',
    make: () => hsplit([33, 34, 33], [stdButton('A', 'BTN_BACK', 15), stdButton('B', 'BTN_HELP', 15), stdButton('C', 'BTN_YES', 15)]) },
  { id: 'menu', label: 'Menu (3 items)', note: 'make_menu_activity() body: buttons in a column',
    make: () => vsplit([33, 34, 33], [stdButton('First', 'BTN_YES', 5), stdButton('Second', 'BTN_NO', 4), stdButton('Third', 'BTN_HELP', 4)]) },
  { id: 'button', label: 'Labelled button', note: 'add_button(): a button with a centred text',
    make: () => stdButton('Continue', 'BTN_YES', 15) },
  { id: 'lines', label: 'Message lines (2)', note: 'make_show_message_activity(): fixed-height lines',
    make: () => vsplit([22, 22], [text('First line'), text('Second line')], { splitKind: 'absolute', padding: [8, 2, 0, 2] }) },
  { id: 'carousel', label: 'Carousel', note: 'make_carousel_activity(): ◀ item ▶ on the highlight colour',
    make: () => makeNode('fill', { fillType: 'highlight', color: HIGHLIGHT }, [
      hsplit([10, 80, 10], [
        text('H', { font: 'JADE_SYMBOLS_16x16_FONT', halign: 'right' }),
        makeNode('fill', { fillType: 'highlight', color: HIGHLIGHT }, [text('Item')]),
        text('I', { font: 'JADE_SYMBOLS_16x16_FONT', halign: 'left' }),
      ])]) },
  { id: 'progress', label: 'Progress bar', note: 'make_progress_bar(): the left border is the progress',
    make: () => makeNode('fill', { margins: [4, 16, 4, 16], border: border('TFT_WHITE', 2, 15) }, [
      makeNode('fill', { margins: [2, 2, 2, 2], border: border(HIGHLIGHT, 80, 8) })]) },
  { id: 'value', label: 'Label + value', note: 'two texts side by side, as in the info screens',
    make: () => hsplit([40, 60], [text('Name', { halign: 'left', color: 'GUI_BLOCKSTREAM_HIGHTLIGHT_DARKGREY' }), text('value', { halign: 'right' })], { padding: [0, 4, 0, 4] }) },
];

const PRIMITIVES = [
  { kind: 'vsplit', label: 'vsplit', note: 'rows, top to bottom', make: () => vsplit([50, 50], []) },
  { kind: 'hsplit', label: 'hsplit', note: 'columns, left to right', make: () => hsplit([50, 50], []) },
  { kind: 'fill', label: 'fill', note: 'coloured rectangle', make: () => makeNode('fill', { color: 'GUI_BLOCKSTREAM_JADE_GREEN' }) },
  { kind: 'button', label: 'button', note: 'selectable, posts an event', make: () => makeNode('button', { border: border('GUI_BLOCKSTREAM_BUTTONBORDER_GREY', 1, 15) }) },
  { kind: 'text', label: 'text', note: 'a string in a firmware font', make: () => text('Text') },
  { kind: 'picture', label: 'picture', note: 'an image from jade/logo', make: () => makeNode('picture') },
  { kind: 'qrguide', label: 'qrguide', note: 'QR scanning corners', make: () => makeNode('qrguide') },
];

// complete screens, as built by the ui helpers
const PRESETS = [
  { id: 'yesno', label: 'Question with No / Yes (await_yesno_activity)', make: () =>
    vsplit([20, 80], [titleBar('Confirm'),
      vsplit([69, 31], [
        vsplit([22, 22], [text('Do you want to'), text('continue?')], { splitKind: 'absolute', padding: [16, 2, 0, 2] }),
        hsplit([50, 50], [stdButton('No', 'BTN_NO', 15), stdButton('Yes', 'BTN_YES', 15)])])]) },
  { id: 'menu', label: 'Menu with 3 items (make_menu_activity)', make: () =>
    vsplit([20, 80], [hsplit([15, 70, 15], [stdButton('=', 'BTN_BACK', 11, { font: 'JADE_SYMBOLS_16x16_FONT' }), text('Options', { font: 'GUI_TITLE_FONT' }), stdButton('?', 'BTN_HELP', 11)]),
      vsplit([33, 34, 33], [stdButton('Wallet', 'BTN_YES', 5), stdButton('Settings', 'BTN_NO', 4), stdButton('About', 'BTN_HELP', 4)])]) },
  { id: 'message', label: 'Message with Continue (make_show_message_activity)', make: () =>
    vsplit([75, 25], [text('Your device is ready to use.', { padding: [0, 2, 0, 2] }), stdButton('Continue', 'BTN_YES', 15)]) },
  { id: 'carousel', label: 'Carousel (make_carousel_activity)', make: () =>
    vsplit([20, 80], [titleBar('Select word', false), vsplit([40, 35, 25], [
      makeNode('fill', {}, [text('Word 1', { padding: [0, 8, 0, 0] })]),
      BLOCKS.find((b) => b.id === 'carousel').make(),
      makeNode('fill')])]) },
  { id: 'progress', label: 'Progress (make_progress_bar_activity)', make: () =>
    vsplit([20, 80], [titleBar('Updating', false), vsplit([25, 45, 30], [
      text('Uploading firmware', { padding: [0, 12, 0, 12] }),
      BLOCKS.find((b) => b.id === 'progress').make(),
      makeNode('fill', {}, [text('42%')])])]) },
  { id: 'logo', label: 'Logo splash', make: () =>
    vsplit([70, 30], [makeNode('picture', { logo: 'ce.bin.gz' }), text('Blockstream Jade', { font: 'GUI_TITLE_FONT' })]) },
  { id: 'empty', label: 'Empty screen', make: () => null },
];

function newDesign(child = PRESETS[0].make()) {
  const root = makeNode('root');
  if (child) root.children.push(child);
  return { device: 'v1', width: 240, height: 135, statusBar: false, title: '', theme: 0, qr: 1,
    fn: 'make_my_screen_activity', root };
}

let design = null;
let selectedId = null;
let lastLayout = null;      // { boxes: Map(id → box), order: [box], warnings, selectedButton }
const undoStack = [], redoStack = [];
const STORE_KEY = 'jade.church.screen-designer';
let buttonEvents = DEFAULT_EVENTS.slice();
let logoNames = ['ce.bin.gz', 'fcc.bin.gz', 'splash.bin.gz', 'statusbar_large.bin.gz', 'statusbar_small.bin.gz', 'telec.bin.gz', 'weee.bin.gz'];

function* walk(node, parent = null, depth = 0) {
  yield { node, parent, depth };
  for (const c of node.children) yield* walk(c, node, depth + 1);
}
const findEntry = (id) => { for (const e of walk(design.root)) if (e.node.id === id) return e; return null; };
const selected = () => findEntry(selectedId)?.node || design.root;
function renumber(node) { node.id = nextId++; node.children.forEach(renumber); return node; }
function maxId(node) { return Math.max(node.id, ...node.children.map(maxId)); }

function screenSize() {
  if (design.device === 'custom') return { w: design.width, h: design.height };
  return DEVICES[design.device];
}
const deepStatusBar = () => screenSize().h >= 170;               // HOME_SCREEN_DEEP_STATUS_BAR
const statusBarHeight = () => deepStatusBar() ? 44 : 24;        // GUI_STATUS_BAR_HEIGHT

// ---------------------------------------------------------------- history
function snapshot() { return JSON.stringify(design); }
function commit(mutate) {
  const before = snapshot();
  mutate();
  if (snapshot() === before) { refresh(); return; }
  undoStack.push(before);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  refresh();
}
function restore(json) { design = JSON.parse(json); nextId = maxId(design.root) + 1; if (!findEntry(selectedId)) selectedId = design.root.id; }
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); refresh(); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); refresh(); }

// ---------------------------------------------------------------- colours
const swap16 = (v) => ((v & 0xFF) << 8) | (v >> 8);
function colorValue(token, theme = design.theme) {       // → firmware color_t (byte-swapped)
  if (token === HIGHLIGHT) return THEMES[theme] ?? THEMES[0];
  if (COLOR_BY_NAME.has(token)) return COLOR_BY_NAME.get(token);
  const m = /^#([0-9a-f]{6})$/i.exec(token || '');
  if (!m) return 0;
  const v = parseInt(m[1], 16), r = v >> 16, g = (v >> 8) & 0xFF, b = v & 0xFF;
  return swap16(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3));
}
function rgb565ToCss(cpu) {
  const r = (cpu >> 11) & 31, g = (cpu >> 5) & 63, b = cpu & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}
const tokenCss = (token) => { const [r, g, b] = rgb565ToCss(swap16(colorValue(token))); return `rgb(${r},${g},${b})`; };
const tokenHex = (token) => '#' + rgb565ToCss(swap16(colorValue(token))).map((v) => v.toString(16).padStart(2, '0')).join('');
function colorC(token) {
  if (token === HIGHLIGHT) return 'gui_get_highlight_color()';
  if (COLOR_BY_NAME.has(token)) return token;
  const v = colorValue(token);
  return `0x${v.toString(16).toUpperCase().padStart(4, '0')} /* ${tokenHex(token)} */`;
}

// ---------------------------------------------------------------- fonts and logos
const fontCache = new Map();    // file → font | 'loading' | Error
const logoCache = new Map();    // file → { width, height, pixels: Uint16Array } | 'loading' | Error

function parseFontC(src) {
  const decl = /unsigned\s+char\s+\w+\s*\[[^\]]*\]\s*(?:PROGMEM\s*)?=\s*\{([\s\S]*?)\}/.exec(src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''));
  if (!decl) throw new Error('no font array');
  const b = Uint8Array.from(decl[1].split(',').map((t) => t.trim()).filter(Boolean).map(Number));
  const f = { bytes: b, x_size: b[0], y_size: b[1], glyphs: new Map() };
  if (f.x_size) {           // fixed width
    f.offset = b[2]; f.numchars = b[3];
  } else {                   // proportional: get_max_width_height()
    let p = 4, ySize = 0;
    while (p < b.length && b[p] !== 0xFF) {
      const [code, yOff, w, h, rawX, xDelta] = b.subarray(p, p + 6);
      if (!f.glyphs.has(code)) f.glyphs.set(code, { yOff, w, h, xOff: rawX < 0x80 ? rawX : -(0xFF - rawX), xDelta, data: p + 6 });
      ySize = Math.max(ySize, h, yOff + h);
      p += 6 + (w ? Math.floor((w * h - 1) / 8) + 1 : 0);
    }
    f.y_size = ySize;
  }
  return f;
}
function getFont(id) {
  const file = FONT_FILE.get(id) || 'DefaultFont.c';
  const f = fontCache.get(file);
  if (f && f !== 'loading') return f instanceof Error ? null : f;
  if (!f) {
    fontCache.set(file, 'loading');
    fetch(`/api/fonts/${encodeURIComponent(file)}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
      .then((src) => fontCache.set(file, parseFontC(src)))
      .catch((e) => fontCache.set(file, new Error(`${file}: ${e.message}`)))
      .finally(() => scheduleRender());
  }
  return undefined;
}
function getLogo(file) {
  const l = logoCache.get(file);
  if (l && l !== 'loading') return l instanceof Error ? null : l;
  if (!l) {
    logoCache.set(file, 'loading');
    fetch(`/api/logos/${encodeURIComponent(file)}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); })
      .then((blob) => new Response(blob.stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer())
      .then((buf) => {
        const bytes = new Uint8Array(buf), width = bytes[0], len = bytes[1] | (bytes[2] << 8);
        if (!width || len % 2 || len !== bytes.length - 3) throw new Error('invalid image');
        const pixels = new Uint16Array(len / 2);
        for (let i = 0; i < pixels.length; i++) pixels[i] = (bytes[3 + 2 * i] << 8) | bytes[4 + 2 * i];
        logoCache.set(file, { width, height: pixels.length / width, pixels });
      })
      .catch((e) => logoCache.set(file, new Error(`${file}: ${e.message}`)))
      .finally(() => scheduleRender());
  }
  return undefined;
}
let renderQueued = false;
function scheduleRender() { if (!renderQueued) { renderQueued = true; requestAnimationFrame(() => { renderQueued = false; renderScreen(); }); } }

// ---------------------------------------------------------------- display.c
class Display {
  constructor(w, h) { this.w = w; this.h = h; this.px = new Uint16Array(w * h); this.warnings = []; }
  plot(x, y, cpu) {                                                   // is_within_limits + draw_bitmap
    if (x < 0 || y < 0 || x > this.w || y > this.h) return;
    if (x < this.w && y < this.h) this.px[y * this.w + x] = cpu;
  }
  fillRect(x, y, w, h, color, who) {                                  // display_fill_rect()
    const W = this.w, H = this.h;
    if (x >= W || y > H) return;
    if (x < 0) { w -= -x; x = 0; }
    if (y < 0) { h -= -y; y = 0; }
    if (w < 0) w = 0;
    if (h < 0) h = 0;
    if (x + w > W + 1) w = W - x + 1;
    if (y + h > H + 1) h = H - y + 1;
    if (w === 0) w = 1;
    if (h === 0) h = 1;
    if (x + w > W || y + h > H) {
      this.warnings.push(`${who}: display_fill_rect(${x}, ${y}, ${w}, ${h}) goes past the display edge, so the firmware ignores it`);
      return;
    }
    const cpu = swap16(color);
    for (let j = y; j < y + h; j++) this.px.fill(cpu, j * W + x, j * W + x + w);
  }
  stringWidth(f, s) {                                                  // display_get_string_width()
    if (f.x_size) return s.length * f.x_size;
    let w = 0;
    for (const ch of s) { const g = f.glyphs.get(ch.charCodeAt(0) & 0xFF); if (g) w += Math.max(g.w, g.xDelta) + 1; }
    return w - 1;
  }
  printInArea(f, st, x, y, cs, wrap, color) {                          // display_print_in_area()
    if (!st) return;
    const cpu = swap16(color);
    if (x > CENTER) x += cs.x1;
    if (y > CENTER) y += cs.y1;
    const tw = this.stringWidth(f, st), fh = f.y_size;
    if (x === RIGHT) x = cs.x2 - tw; else if (x === CENTER) x = Math.trunc((cs.x2 - cs.x1 - tw) / 2) + cs.x1;
    if (y === BOTTOM) y = cs.y2 - fh; else if (y === CENTER) y = Math.trunc((cs.y2 - cs.y1 - fh) / 2) + cs.y1;
    if (x < cs.x1) x = cs.x1;
    if (y < cs.y1) y = cs.y1;
    if (x > cs.x2 || y > cs.y2) return;
    let X = x, Y = y, tmpw = f.x_size;
    const tmph = f.y_size;
    if (Y + tmph - 1 > cs.y2) return 'clipped';
    for (let i = 0; i < st.length; i++) {
      let ch = st.charCodeAt(i) & 0xFF, g = null;
      if (ch === 0x0A) {
        Y += tmph;
        if (Y > cs.y2 - tmph) return 'clipped';
        X = cs.x1;
        continue;
      }
      if (!f.x_size) { g = f.glyphs.get(ch); if (!g) continue; tmpw = g.xDelta; }
      if (X + tmpw > cs.x2) {
        if (!wrap) return 'clipped';
        Y += tmph;
        if (Y > cs.y2 - tmph) return 'clipped';
        X = cs.x1;
      }
      if (!f.x_size) {                                                  // print_proportional_char()
        const b = f.bytes;
        let ptr = g.data, byte = 0, mask = 0x80;
        for (let j = 0; j < g.h; j++) {
          for (let k = 0; k < g.w; k++) {
            if (!((k + j * g.w) % 8)) { mask = 0x80; byte = b[ptr++]; }
            if (byte & mask) this.plot(X + g.xOff + k, Y + j + g.yOff, cpu);
            mask >>= 1;
          }
        }
        X += Math.max(g.w, g.xDelta) + 1;
      } else {                                                          // print_char()
        if (ch < f.offset || ch - f.offset > f.numchars) ch = f.offset;
        const fz = (f.x_size + 7) >> 3;
        let p = (ch - f.offset) * fz * f.y_size + 4;
        for (let j = 0; j < f.y_size; j++, p += fz) {
          for (let k = 0; k < fz; k++) {
            const byte = f.bytes[p + k] || 0;
            for (let bit = 0; bit < 8; bit++) if (byte & (0x80 >> bit)) this.plot(X + bit + (k << 3), Y + j, cpu);
          }
        }
        X += tmpw;
      }
    }
    return null;
  }
  picture(img, x, y, cs, who) {                                        // display_picture()
    const cx = x === CENTER ? Math.trunc((cs.x2 - cs.x1 - img.width) / 2) + cs.x1 : x === RIGHT ? cs.x2 - img.width : x + cs.x1;
    const cy = y === CENTER ? Math.trunc((cs.y2 - cs.y1 - img.height) / 2) + cs.y1 : y === BOTTOM ? cs.y2 - img.height : y + cs.y1;
    if (cx < 0 || cy < 0 || cx + img.width > this.w || cy + img.height > this.h) {
      this.warnings.push(`${who}: the ${img.width}×${img.height} picture does not fit on the display: display_picture() asserts`);
    }
    for (let j = 0; j < img.height; j++) {
      for (let i = 0; i < img.width; i++) {
        const X = cx + i, Y = cy + j;
        if (X >= 0 && Y >= 0 && X < this.w && Y < this.h) this.px[Y * this.w + X] = img.pixels[j * img.width + i];
      }
    }
  }
}

// ---------------------------------------------------------------- gui.c
const HALIGN = { left: 0, center: CENTER, right: RIGHT };
const VALIGN = { top: 0, middle: CENTER, bottom: BOTTOM };

function nodeLabel(n) {
  const k = KINDS[n.kind].label;
  if (n.name) return `${n.name} (${k})`;
  if (n.kind === 'text') return `text "${n.text.length > 18 ? n.text.slice(0, 17) + '…' : n.text}"`;
  if (n.kind === 'button') return `button ${n.event}`;
  if (n.kind === 'picture') return `picture ${n.logo}`;
  if (n.kind === 'vsplit' || n.kind === 'hsplit') return `${k} ${n.values.map((v) => v === FILL_REMAINING ? 'fill' : v).join(' / ')}${n.splitKind === 'absolute' ? ' px' : ' %'}`;
  return k;
}

// Lay out and paint `root` in `win`, recording each node's boxes (render_activity)
function renderTree(disp, root, win, opts) {
  const boxes = new Map(), order = [], warnings = disp.warnings;
  const buttons = [];

  // pass 1: constraints (pre_render_node + calc_render_data), so the selection is known before painting
  function layout(n, cs) {
    const bt = (bit) => n.border ? n.border.thickness * ((n.border.sides >> bit) & 1) : 0;
    const outer = { x1: cs.x1 + n.margins[3], y1: cs.y1 + n.margins[0], x2: cs.x2 - n.margins[1], y2: cs.y2 - n.margins[2] };
    const inner = {
      x1: outer.x1 + bt(3) + n.padding[3], y1: outer.y1 + bt(0) + n.padding[0],
      x2: outer.x2 - bt(1) - n.padding[1], y2: outer.y2 - bt(2) - n.padding[2],
    };
    if (inner.x2 < inner.x1 || inner.y2 < inner.y1) {
      warnings.push(`${nodeLabel(n)}: margins, border and padding are bigger than its ${cs.x2 - cs.x1}×${cs.y2 - cs.y1} area`);
      inner.x2 = Math.max(inner.x1, inner.x2); inner.y2 = Math.max(inner.y1, inner.y2);
    }
    const box = { node: n, cs, outer, inner, kids: [] };
    boxes.set(n.id, box);
    order.push(box);
    if (n.kind === 'button') buttons.push(box);
    if (n.kind === 'vsplit' || n.kind === 'hsplit') {
      const vert = n.kind === 'vsplit';
      const max = vert ? inner.y2 : inner.x2;
      let pos = vert ? inner.y1 : inner.x1;
      const total = max - pos;
      const parts = n.values.length;
      if (n.children.length > parts) warnings.push(`${nodeLabel(n)}: has ${n.children.length} children but ${parts} parts, so the last ${n.children.length - parts} are not drawn`);
      n.children.slice(0, parts).forEach((c, i) => {
        const v = n.values[i];
        const step = v === FILL_REMAINING ? max - pos : n.splitKind === 'absolute' ? v : Math.floor(total * v / 100);
        const end = Math.min(pos + step, max);
        box.kids.push(layout(c, vert ? { x1: inner.x1, x2: inner.x2, y1: pos, y2: end } : { x1: pos, x2: end, y1: inner.y1, y2: inner.y2 }));
        pos = end;
      });
      if (n.splitKind === 'relative' && !n.values.includes(FILL_REMAINING)) {
        const sum = n.values.reduce((a, b) => a + b, 0);
        if (sum > 100) warnings.push(`${nodeLabel(n)}: the parts add up to ${sum}%, the last ones are squeezed`);
      }
    } else if (n.children.length && n.kind !== 'text') {
      box.kids.push(layout(n.children[0], inner));
      if (n.children.length > 1) warnings.push(`${nodeLabel(n)}: a ${n.kind === 'root' ? 'root fill' : n.kind} draws only its first child`);
    }
    return box;
  }
  const top = layout(root, win);

  // the selection: initial_selection when active, else the first active button on screen (is_before)
  const active = (b) => b.node.active !== false;
  let sel = null;
  if (opts.showSelection) {
    sel = buttons.find((b) => b.node.initial && active(b))
      || buttons.filter(active).sort((a, b) => a.cs.y1 - b.cs.y1 || a.cs.x1 - b.cs.x1)[0] || null;
  }

  // pass 2: repaint_node()
  function paint(box, isSel, isActive) {
    const n = box.node;
    if (n.kind === 'button') { isSel = box === sel; isActive = n.active !== false; }
    const who = nodeLabel(n), cs = box.inner;
    if (n.border) {
      const o = box.outer, w = o.x2 - o.x1, h = o.y2 - o.y1, b = n.border;
      const c = colorValue(isSel ? (b.selected || b.color) : !isActive ? (b.inactive || b.color) : b.color);
      const t = (bit) => b.thickness * ((b.sides >> bit) & 1);
      if (t(0)) disp.fillRect(o.x1, o.y1, w, t(0), c, who);
      if (t(1)) disp.fillRect(o.x2 - t(1), o.y1, t(1), h, c, who);
      if (t(2)) disp.fillRect(o.x1, o.y2 - t(2), w, t(2), c, who);
      if (t(3)) disp.fillRect(o.x1, o.y1, t(3), h, c, who);
    }
    const pick = (c, s) => colorValue(isSel ? (s || c) : c);
    switch (n.kind) {
      case 'root': case 'fill': {
        const c = n.fillType === 'highlight' ? THEMES[design.theme] : n.fillType === 'qr' ? QR_COLORS[design.qr] : pick(n.color, n.selectedColor);
        disp.fillRect(cs.x1, cs.y1, cs.x2 - cs.x1, cs.y2 - cs.y1, c, who);
        break;
      }
      case 'button':
        if (isSel || n.color !== (n.selectedColor || n.color)) disp.fillRect(cs.x1, cs.y1, cs.x2 - cs.x1, cs.y2 - cs.y1, pick(n.color, n.selectedColor), who);
        break;
      case 'text': {
        const f = getFont(n.font);
        if (f === undefined) break;
        if (!f) { warnings.push(`${who}: cannot load the font`); break; }
        const r = disp.printInArea(f, n.text.slice(0, 255), HALIGN[n.halign], VALIGN[n.valign], cs, !n.scroll, pick(n.color, n.selectedColor));
        if (r === 'clipped' && !n.scroll) warnings.push(`${who}: does not fit in its ${cs.x2 - cs.x1}×${cs.y2 - cs.y1} area, part of it is not drawn`);
        break;
      }
      case 'picture': {
        const img = getLogo(n.logo);
        if (img === null) warnings.push(`${who}: cannot load jade/logo/${n.logo}`);
        else if (img) disp.picture(img, HALIGN[n.halign], VALIGN[n.valign], cs, who);
        break;
      }
      case 'qrguide': {
        const width = cs.x2 - cs.x1, height = cs.y2 - cs.y1, sq = Math.min(width, height);
        const inset = Math.floor(sq / (design.device === 'v1' ? 11 : 30));
        const L = cs.x1 + Math.floor((width - sq) / 2) + inset, R = cs.x2 - Math.floor((width - sq) / 2) - inset;
        const T = cs.y1 + Math.floor((height - sq) / 2) + inset, B = cs.y2 - Math.floor((height - sq) / 2) - inset;
        const gw = 2, gl = 30, gn = 2, c = colorValue(n.color), F = (x, y, w, h) => disp.fillRect(x, y, w, h, c, who);
        F(L, T, gw, gl); F(L, T, gl, gw); F(L + gl, T, gn, gw / 2); F(L, T + gl, gw / 2, gn);
        F(R - gw, T, gw, gl); F(R - gl, T, gl, gw); F(R - gl - gn, T, gn, gw / 2); F(R - gw / 2, T + gl, gw / 2, gn);
        F(L, B - gl, gw, gl); F(L, B - gw, gl, gw); F(L + gl, B - gw / 2, gn, gw / 2); F(L, B - gl - gn, gw / 2, gn);
        F(R - gw, B - gl, gw, gl); F(R - gl, B - gw, gl, gw); F(R - gl - gn, B - gw / 2, gn, gw / 2); F(R - gw / 2, B - gl - gn, gw / 2, gn);
        break;
      }
    }
    for (const k of box.kids) paint(k, isSel, isActive);
  }
  paint(top, false, true);
  return { boxes, order, selectedButton: sel };
}

function statusBarTree(title) {    // make_status_bar() in gui.c
  const sym = (t, font, halign) => text(t, { font, halign });
  const titleNode = text(title || '', { font: 'GUI_TITLE_FONT', halign: deepStatusBar() ? 'right' : 'left' });
  const root = makeNode('fill');
  if (deepStatusBar()) {
    root.children.push(hsplit([65, 35], [
      makeNode('picture', { logo: 'statusbar_large.bin.gz', halign: 'left' }),
      vsplit([50, 50], [
        hsplit([28, 28, 44], [sym('D', 'JADE_SYMBOLS_16x16_FONT', 'center'), sym('F', 'JADE_SYMBOLS_16x16_FONT', 'center'), sym('0', 'JADE_SYMBOLS_16x32_FONT', 'right')], { padding: [0, 4, 0, 2] }),
        makeNode('fill', {}, [titleNode])])], { padding: [0, 2, 0, 2] }));
  } else {
    root.children.push(hsplit([10, 57, 8, 8, 17], [
      makeNode('picture', { logo: 'statusbar_small.bin.gz', halign: 'left' }),
      makeNode('fill', {}, [titleNode]),
      sym('D', 'JADE_SYMBOLS_16x16_FONT', 'center'), sym('F', 'JADE_SYMBOLS_16x16_FONT', 'center'), sym('0', 'JADE_SYMBOLS_16x32_FONT', 'right')],
    { padding: [3, 0, 0, 4] }));
  }
  return root;
}

// ---------------------------------------------------------------- preview
const canvas = $('#sd-canvas');
const ctx = canvas.getContext('2d');

function renderScreen() {
  const { w, h } = screenSize();
  const disp = new Display(w, h);
  let win = { x1: 0, y1: 0, x2: w, y2: h };
  if (design.statusBar) {
    const sbId = nextId;
    renderTree(disp, statusBarTree(design.title), { x1: 0, y1: 0, x2: w, y2: statusBarHeight() }, { showSelection: false });
    nextId = sbId;
    disp.warnings.length = 0;    // the firmware's own status bar is not the user's concern
    win = { ...win, y1: statusBarHeight() };
  }
  lastLayout = renderTree(disp, design.root, win, { showSelection: $('#sd-show-sel').checked });
  lastLayout.warnings = [...new Set(disp.warnings)];
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < disp.px.length; i++) {
    const [r, g, b] = rgb565ToCss(disp.px[i]);
    img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const zoom = currentZoom();
  canvas.style.width = `${w * zoom}px`;
  canvas.style.height = `${h * zoom}px`;
  $('#sd-size').textContent = `${w} × ${h} px` + (design.statusBar ? ` · status bar ${statusBarHeight()} px` : '');
  drawHighlight();
  const ul = $('#sd-warnings');
  ul.textContent = '';
  for (const wmsg of lastLayout.warnings) ul.append(el('li', null, wmsg));
}

// "fit": the biggest whole zoom that fits the preview column (at least 1)
function currentZoom() {
  const z = $('#sd-zoom').value;
  if (z !== 'auto') return Number(z);
  const avail = $('.sd-stage-wrap').clientWidth - 28 - 22;
  return Math.max(1, Math.min(6, Math.floor(avail / screenSize().w)));
}

function placeBox(div, r) {
  const zoom = currentZoom();
  div.hidden = false;
  div.style.left = `${r.x1 * zoom}px`;
  div.style.top = `${r.y1 * zoom}px`;
  div.style.width = `${Math.max(0, r.x2 - r.x1) * zoom}px`;
  div.style.height = `${Math.max(0, r.y2 - r.y1) * zoom}px`;
}
function drawHighlight() {
  const box = lastLayout?.boxes.get(selectedId);
  $('#sd-hl-outer').hidden = $('#sd-hl-inner').hidden = true;
  if (!box) return;
  placeBox($('#sd-hl-outer'), box.outer);
  const i = box.inner, o = box.outer;
  if (i.x1 !== o.x1 || i.y1 !== o.y1 || i.x2 !== o.x2 || i.y2 !== o.y2) placeBox($('#sd-hl-inner'), i);
}

function boxAt(ev) {
  if (!lastLayout) return null;
  const r = canvas.getBoundingClientRect();
  const x = (ev.clientX - r.left) * canvas.width / r.width, y = (ev.clientY - r.top) * canvas.height / r.height;
  let hit = null;
  for (const b of lastLayout.order) {
    const o = b.outer;
    if (x >= o.x1 && x < o.x2 && y >= o.y1 && y < o.y2) hit = b;   // painted later = deeper
  }
  return { hit, x: Math.floor(x), y: Math.floor(y) };
}

// ---------------------------------------------------------------- tree
function canHold(parent, child) {
  if (!parent) return false;
  const max = KINDS[parent.kind].maxChildren;
  if (parent.children.length >= max) return false;
  if (child && containsButton(child)) {
    const e = findEntry(parent.id);
    for (let p = e ? parent : null; p; p = findEntry(p.id)?.parent) if (p.kind === 'button') return false;
  }
  return true;
}
const containsButton = (n) => n.kind === 'button' || n.children.some(containsButton);

function addChild(parent, child, index = parent.children.length) {
  parent.children.splice(index, 0, child);
  if (parent.kind === 'vsplit' || parent.kind === 'hsplit') {
    const n = parent.children.length;
    const wasEven = JSON.stringify(parent.values) === JSON.stringify(evenSplit(n - 1));
    if (parent.values.length >= n) return;
    if (parent.splitKind === 'relative' && wasEven) parent.values = evenSplit(n);
    else if (parent.splitKind === 'relative') parent.values.splice(index, 0, Math.max(0, 100 - parent.values.reduce((a, b) => a + (b === FILL_REMAINING ? 0 : b), 0)));
    else parent.values.splice(index, 0, 20);
  }
}
function removeChild(parent, index) {
  parent.children.splice(index, 1);
  if ((parent.kind === 'vsplit' || parent.kind === 'hsplit') && parent.values.length > parent.children.length) {
    const wasEven = JSON.stringify(parent.values) === JSON.stringify(evenSplit(parent.children.length + 1));
    if (parent.splitKind === 'relative' && wasEven) parent.values = evenSplit(parent.children.length);
    else parent.values.splice(index, 1);
  }
}

function insert(sub) {
  let target = selected();
  let parent, index;
  if (canHold(target, sub)) { parent = target; index = target.children.length; }
  else {
    const e = findEntry(target.id);
    if (e?.parent && canHold(e.parent, sub)) { parent = e.parent; index = e.parent.children.indexOf(target) + 1; }
  }
  if (!parent) {
    toast(containsButton(sub) && target.kind === 'button'
      ? 'A button cannot contain another button.'
      : `${nodeLabel(target)} has no room: a ${KINDS[target.kind].label} draws only one child. Select a split, or wrap it in a split first.`);
    return;
  }
  commit(() => { addChild(parent, sub, index); selectedId = sub.id; });
}

function renderTreeList() {
  const ul = $('#sd-tree');
  ul.textContent = '';
  const drawn = lastLayout ? new Set(lastLayout.boxes.keys()) : null;
  for (const { node, depth } of walk(design.root)) {
    const li = el('li', 'sd-tree-item' + (node.id === selectedId ? ' selected' : '') + (drawn && !drawn.has(node.id) ? ' not-drawn' : ''));
    li.setAttribute('role', 'treeitem');
    li.style.paddingLeft = `${6 + depth * 16}px`;
    li.tabIndex = node.id === selectedId ? 0 : -1;
    const kind = el('span', `sd-kind sd-kind-${node.kind}`, KINDS[node.kind].label);
    li.append(kind, el('span', 'sd-tree-label', node.kind === 'root' ? 'act->root_node' : nodeLabel(node).replace(/^\w+ /, '')));
    if (drawn && !drawn.has(node.id)) li.title = 'Not drawn: its parent has no part or slot for it';
    li.onclick = () => select(node.id);
    ul.append(li);
  }
}

function select(id) { selectedId = id; renderTreeList(); renderInspector(); drawHighlight(); }

function move(delta) {
  const e = findEntry(selectedId);
  if (!e?.parent) return;
  const list = e.parent.children, i = list.indexOf(e.node), j = i + delta;
  if (j < 0 || j >= list.length) return;
  commit(() => {
    [list[i], list[j]] = [list[j], list[i]];
    const v = e.parent.values;
    if (v && j < v.length && i < v.length) [v[i], v[j]] = [v[j], v[i]];
  });
}
function removeSelected() {
  const e = findEntry(selectedId);
  if (!e?.parent) return;
  commit(() => {
    const i = e.parent.children.indexOf(e.node);
    removeChild(e.parent, i);
    selectedId = (e.parent.children[Math.min(i, e.parent.children.length - 1)] || e.parent).id;
  });
}
function duplicate() {
  const e = findEntry(selectedId);
  if (!e?.parent) return;
  const copy = renumber(JSON.parse(JSON.stringify(e.node)));
  if (copy.name) copy.name += '_copy';
  if (!canHold(e.parent, copy)) { toast(`${nodeLabel(e.parent)} has no room for another child.`); return; }
  commit(() => { addChild(e.parent, copy, e.parent.children.indexOf(e.node) + 1); selectedId = copy.id; });
}
function wrapInFill() {
  const e = findEntry(selectedId);
  if (!e?.parent) return;
  commit(() => {
    const f = makeNode('fill');
    e.parent.children[e.parent.children.indexOf(e.node)] = f;
    f.children.push(e.node);
    selectedId = f.id;
  });
}

// ---------------------------------------------------------------- inspector
function field(label, input, hint) {
  const row = el('label', 'sd-field');
  row.append(el('span', 'sd-field-label', label), input);
  if (hint) row.append(el('span', 'sd-hint', hint));
  return row;
}
function numberInput(value, onchange, { min = 0, max = 255 } = {}) {
  const i = el('input'); i.type = 'number'; i.min = min; i.max = max; i.value = value;
  i.onchange = () => { const v = Math.max(min, Math.min(max, Math.round(Number(i.value) || 0))); commit(() => onchange(v)); };
  return i;
}
function selectInput(options, value, onchange) {
  const s = el('select');
  for (const o of options) { const [v, l] = Array.isArray(o) ? o : [o, o]; s.append(new Option(l, v)); }
  s.value = value;
  s.onchange = () => commit(() => onchange(s.value));
  return s;
}
function checkbox(label, value, onchange) {
  const l = el('label', 'fd-check'); const c = el('input'); c.type = 'checkbox'; c.checked = value;
  c.onchange = () => commit(() => onchange(c.checked));
  l.append(c, ` ${label}`);
  return l;
}
function colorInput(value, onchange, { allowSame = false, allowHighlight = true } = {}) {
  const wrap = el('span', 'sd-color');
  const sw = el('span', 'sd-swatch');
  const s = el('select');
  if (allowSame) s.append(new Option('same as normal', ''));
  if (allowHighlight) s.append(new Option('highlight (theme)', HIGHLIGHT));
  for (const [name] of NAMED_COLORS) s.append(new Option(name.replace('GUI_BLOCKSTREAM_', 'BS_'), name));
  s.append(new Option('custom…', 'custom'));
  const custom = el('input'); custom.type = 'color';
  const isCustom = value && value.startsWith('#');
  s.value = value == null ? '' : isCustom ? 'custom' : value;
  custom.hidden = !isCustom;
  custom.value = isCustom ? value : tokenHex(value || 'TFT_BLACK');
  sw.style.background = value == null ? 'transparent' : tokenCss(value);
  s.onchange = () => {
    if (s.value === 'custom') { custom.hidden = false; commit(() => onchange(tokenHex(custom.value))); return; }
    commit(() => onchange(s.value === '' ? null : s.value));
  };
  custom.onchange = () => commit(() => onchange(custom.value));
  wrap.append(sw, s, custom);
  return wrap;
}
function sidesInput(values, onchange, label) {
  const box = el('div', 'sd-sides');
  ['top', 'right', 'bottom', 'left'].forEach((side, i) => {
    const inp = numberInput(values[i], (v) => { values[i] = v; onchange(values); });
    inp.title = `${label} ${side}`;
    inp.setAttribute('aria-label', `${label} ${side}`);
    const cell = el('span', 'sd-side');
    cell.append(el('span', 'sd-side-label', side), inp);
    box.append(cell);
  });
  const all = el('button', 'sd-mini', '='); all.type = 'button'; all.title = 'Use the top value on all sides';
  all.onclick = () => commit(() => onchange([values[0], values[0], values[0], values[0]]));
  box.append(all);
  return box;
}

function renderInspector() {
  const n = selected();
  const help = $('#sd-help');
  help.textContent = '';
  help.append(el('b', null, n.kind === 'root' ? 'act->root_node' : KINDS[n.kind].fn + '()'), el('p', null, KINDS[n.kind].help));
  const box = lastLayout?.boxes.get(n.id);
  if (box) help.append(el('p', 'muted small', `area ${box.cs.x2 - box.cs.x1}×${box.cs.y2 - box.cs.y1} at (${box.cs.x1}, ${box.cs.y1}) · content ${box.inner.x2 - box.inner.x1}×${box.inner.y2 - box.inner.y1}`));
  else if (n.kind !== 'root') help.append(el('p', 'logo-warning small', 'Not drawn: its parent has no part or slot for it.'));

  const p = $('#sd-props');
  p.textContent = '';
  const group = (title) => { const g = el('fieldset', 'sd-group'); g.append(el('legend', null, title)); p.append(g); return g; };

  if (n.kind !== 'root') {
    const g = group('Node');
    const name = el('input'); name.value = n.name; name.placeholder = defaultVarName(n); name.spellcheck = false;
    name.onchange = () => commit(() => { n.name = name.value.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1'); });
    g.append(field('C variable', name));
  }

  const g = group(KINDS[n.kind].label);
  switch (n.kind) {
    case 'root':
      g.append(field('Colour', colorInput(n.color, (v) => { n.color = v; }, { allowHighlight: false })));
      break;
    case 'vsplit': case 'hsplit': {
      g.append(field('Values', selectInput([['relative', 'relative (% of the ' + (n.kind === 'vsplit' ? 'height' : 'width') + ')'], ['absolute', 'absolute (pixels)']], n.splitKind, (v) => {
        const box2 = lastLayout?.boxes.get(n.id);
        const total = box2 ? (n.kind === 'vsplit' ? box2.inner.y2 - box2.inner.y1 : box2.inner.x2 - box2.inner.x1) : 100;
        n.values = n.values.map((x) => x === FILL_REMAINING ? x : v === 'absolute' ? Math.floor(total * x / 100) : Math.round(x * 100 / Math.max(1, total)));
        n.splitKind = v;
      })));
      const list = el('div', 'sd-parts');
      n.values.forEach((v, i) => {
        const row = el('div', 'sd-part');
        const child = n.children[i];
        row.append(el('span', 'sd-part-name', child ? nodeLabel(child) : '(empty part)'));
        const isFill = v === FILL_REMAINING;
        const inp = numberInput(isFill ? 0 : v, (x) => { n.values[i] = x; }, { max: n.splitKind === 'absolute' ? 640 : 254 });
        inp.disabled = isFill;
        const fillBox = el('label', 'fd-check'); const fc = el('input'); fc.type = 'checkbox'; fc.checked = isFill;
        fc.onchange = () => commit(() => { n.values[i] = fc.checked ? FILL_REMAINING : (n.splitKind === 'absolute' ? 20 : 25); });
        fillBox.append(fc, ' fill');
        fillBox.title = 'GUI_SPLIT_FILL_REMAINING: take all the space left';
        const rm = el('button', 'sd-mini', '✕'); rm.type = 'button'; rm.title = child ? 'Remove this part and its child' : 'Remove this empty part';
        rm.onclick = () => commit(() => { if (child) n.children.splice(i, 1); n.values.splice(i, 1); });
        row.append(inp, el('span', 'muted small', n.splitKind === 'absolute' ? 'px' : '%'), fillBox, rm);
        list.append(row);
      });
      g.append(list);
      const add = el('button', null, '＋ Empty part'); add.type = 'button';
      add.title = 'A part with no child leaves its space empty';
      add.onclick = () => commit(() => { n.values.push(n.splitKind === 'absolute' ? 20 : 10); });
      const even = el('button', null, '⇔ Even'); even.type = 'button';
      even.title = 'Split evenly, as make_even_split() does';
      even.onclick = () => commit(() => { n.splitKind = 'relative'; n.values = evenSplit(Math.max(1, n.values.length)); });
      const sum = n.values.reduce((a, b) => a + (b === FILL_REMAINING ? 0 : b), 0);
      const tools = el('div', 'sd-row');
      tools.append(add, even);
      g.append(tools, el('p', 'muted small', `${n.values.length} parts · total ${sum}${n.splitKind === 'absolute' ? ' px' : '%'}`));
      break;
    }
    case 'fill':
      g.append(field('Type', selectInput([['plain', 'FILL_PLAIN: a colour'], ['highlight', 'FILL_HIGHLIGHT: theme colour'], ['qr', 'FILL_QR: QR background colour']], n.fillType, (v) => { n.fillType = v; })));
      if (n.fillType === 'plain') {
        g.append(field('Colour', colorInput(n.color, (v) => { n.color = v; })));
        g.append(field('Selected colour', colorInput(n.selectedColor, (v) => { n.selectedColor = v; }, { allowSame: true }), 'used while a button around it is selected'));
      }
      break;
    case 'button':
      g.append(field('Event id', eventInput(n)));
      g.append(field('Colour', colorInput(n.color, (v) => { n.color = v; })));
      g.append(field('Selected colour', colorInput(n.selectedColor, (v) => { n.selectedColor = v; }, { allowSame: true }), 'same as the colour = transparent button'));
      g.append(checkbox('Active (selectable)', n.active !== false, (v) => { n.active = v; }));
      g.append(checkbox('Initial selection', !!n.initial, (v) => {
        for (const e of walk(design.root)) if (e.node.kind === 'button') e.node.initial = false;
        n.initial = v;
      }));
      break;
    case 'text': {
      // live preview while typing, one undo step when the edit is done
      const textBefore = n.text;
      const ta = el('textarea'); ta.value = n.text; ta.rows = 2; ta.maxLength = 255;
      ta.oninput = () => { n.text = ta.value; renderScreen(); renderCode(); };
      ta.onchange = () => { const v = ta.value; n.text = textBefore; commit(() => { n.text = v; }); };
      g.append(field('Text', ta));
      g.append(field('Font', selectInput(FONTS.map(([id, , d]) => [id, d ? `${id} – ${d}` : id]), n.font, (v) => { n.font = v; })));
      if (SYMBOL_FONTS.has(n.font)) g.append(glyphPicker(n));
      g.append(field('Colour', colorInput(n.color, (v) => { n.color = v; })));
      g.append(field('Selected colour', colorInput(n.selectedColor, (v) => { n.selectedColor = v; }, { allowSame: true }), 'while the button it is in is selected'));
      g.append(alignInputs(n));
      g.append(checkbox('Scroll instead of wrapping', n.scroll, (v) => { n.scroll = v; }));
      if (n.scroll) g.append(field('Scroll background', colorInput(n.scrollBg, (v) => { n.scrollBg = v; })));
      break;
    }
    case 'picture':
      g.append(field('Image', selectInput(logoNames, n.logo, (v) => { n.logo = v; }), 'from jade/logo (see the logo designer)'));
      g.append(alignInputs(n));
      break;
    case 'qrguide':
      g.append(field('Colour', colorInput(n.color, (v) => { n.color = v; }, { allowHighlight: false })));
      break;
  }

  if (n.kind === 'root') return;
  const lay = group('Box');
  lay.append(field('Margins', sidesInput(n.margins.slice(), (v) => { n.margins = v; }, 'margin')));
  lay.append(field('Padding', sidesInput(n.padding.slice(), (v) => { n.padding = v; }, 'padding')));
  const bg = group('Border');
  bg.append(checkbox('Border', !!n.border, (v) => { n.border = v ? border('GUI_BLOCKSTREAM_BUTTONBORDER_GREY', 1, 15) : null; }));
  if (n.border) {
    const b = n.border;
    bg.append(field('Thickness', numberInput(b.thickness, (v) => { b.thickness = v; }, { max: 640 })));
    const sides = el('div', 'sd-row');
    for (const [name, bit] of BORDER_SIDES) {
      const c = checkbox(name.toLowerCase(), !!(b.sides & bit), (v) => { b.sides = v ? b.sides | bit : b.sides & ~bit; });
      sides.append(c);
    }
    bg.append(field('Sides', sides));
    bg.append(field('Colour', colorInput(b.color, (v) => { b.color = v; })));
    bg.append(field('Selected colour', colorInput(b.selected, (v) => { b.selected = v; }, { allowSame: true })));
    bg.append(field('Inactive colour', colorInput(b.inactive, (v) => { b.inactive = v; }, { allowSame: true }), 'while the button is not active'));
  }
}

function eventInput(n) {
  const wrap = el('span', 'sd-event');
  const inp = el('input'); inp.value = n.event; inp.setAttribute('list', 'sd-events'); inp.spellcheck = false;
  inp.onchange = () => commit(() => { n.event = inp.value.trim().replace(/[^A-Za-z0-9_]/g, '_') || 'BTN_YES'; });
  let dl = $('#sd-events');
  if (!dl) { dl = el('datalist'); dl.id = 'sd-events'; document.body.append(dl); }
  dl.textContent = '';
  for (const ev of buttonEvents) dl.append(new Option(ev));
  wrap.append(inp);
  return wrap;
}
function alignInputs(n) {
  const row = el('div', 'sd-row');
  row.append(selectInput([['left', 'left'], ['center', 'center'], ['right', 'right']], n.halign, (v) => { n.halign = v; }));
  row.append(selectInput([['top', 'top'], ['middle', 'middle'], ['bottom', 'bottom']], n.valign, (v) => { n.valign = v; }));
  return field('Align', row);
}
function glyphPicker(n) {
  const f = getFont(n.font);
  const wrap = el('div', 'sd-glyphs');
  if (!f) { wrap.textContent = 'Loading glyphs…'; return wrap; }
  const codes = f.x_size ? Array.from({ length: f.numchars }, (_, i) => f.offset + i) : [...f.glyphs.keys()];
  for (const code of codes) {
    const c = el('canvas', 'sd-glyph');
    const w = f.x_size || Math.max(1, ...[...f.glyphs.values()].map((g) => g.xOff + Math.max(g.w, g.xDelta)));
    c.width = w; c.height = f.y_size;
    const d = new Display(w, f.y_size);
    d.px.fill(0);
    d.printInArea(f, String.fromCharCode(code), 0, 0, { x1: 0, y1: 0, x2: w, y2: f.y_size }, false, 0xFFFF);
    const cx = c.getContext('2d'), im = cx.createImageData(w, f.y_size);
    d.px.forEach((v, i) => { im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v ? 230 : 30; im.data[i * 4 + 3] = 255; });
    cx.putImageData(im, 0, 0);
    const b = el('button', 'sd-glyph-btn'); b.type = 'button';
    b.title = `'${String.fromCharCode(code)}' (0x${code.toString(16)}) – click to use, shift-click to append`;
    b.append(c);
    b.onclick = (ev) => commit(() => { n.text = ev.shiftKey ? n.text + String.fromCharCode(code) : String.fromCharCode(code); });
    wrap.append(b);
  }
  return field('Glyphs', wrap);
}

// ---------------------------------------------------------------- C code
function defaultVarName(n) { return n.kind === 'root' ? 'act->root_node' : n.kind; }
function cString(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0) & 0xFF;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (c < 0x20 || c > 0x7E) out += '\\' + c.toString(8).padStart(3, '0');
    else out += ch;
  }
  return `"${out}"`;
}
function sidesC(v) {
  const [t, r, b, l] = v;
  if (t === r && r === b && b === l) return `GUI_MARGIN_ALL_EQUAL, ${t}`;
  if (t === b && r === l) return `GUI_MARGIN_TWO_VALUES, ${t}, ${r}`;
  return `GUI_MARGIN_ALL_DIFFERENT, ${t}, ${r}, ${b}, ${l}`;
}
function sidesNameC(bits) {
  const exact = BORDER_NAMES.find(([v]) => v === bits);
  if (exact) return exact[1];
  return BORDER_SIDES.filter(([, bit]) => bits & bit).map(([name]) => `GUI_BORDER_${name}`).join(' | ') || '0';
}
const logoSym = (file) => file.replace(/[^A-Za-z0-9]/g, '_');

function generateC() {
  const { w, h } = screenSize();
  const fn = (design.fn || 'make_my_screen_activity').replace(/[^A-Za-z0-9_]/g, '_');
  const used = new Set(['act']);
  const names = new Map();
  const counters = {};
  for (const { node } of walk(design.root)) {
    if (node.kind === 'root') { names.set(node.id, 'act->root_node'); continue; }
    let base = node.name || node.kind;
    let name = base;
    if (!node.name || used.has(name)) {
      do { counters[base] = (counters[base] || 0) + 1; name = `${base}${counters[base]}`; } while (used.has(name));
    }
    used.add(name);
    names.set(node.id, name);
  }
  const drawn = lastLayout ? new Set(lastLayout.boxes.keys()) : null;
  const logos = new Set(), events = new Set(), body = [], after = [];
  const L = (s = '') => body.push(s ? '    ' + s : '');

  if (design.statusBar) {
    L(`gui_activity_t* act = NULL;`);
    L(`gui_make_activity_ex(&act, true, ${design.title ? cString(design.title) : 'NULL'}, true);`);
    L(`act->selectables_wrap = true; // as gui_make_activity() does`);
  } else {
    L('gui_activity_t* const act = gui_make_activity();');
  }
  if (design.root.color !== 'TFT_BLACK') L(`gui_set_color(act->root_node, ${colorC(design.root.color)});`);

  function emit(n, parentName) {
    const v = names.get(n.id);
    L();
    if (drawn && !drawn.has(n.id)) L(`// NOTE: ${v} is not drawn: its parent has no part for it`);
    L(`gui_view_node_t* ${v};`);
    const twoColors = (c, s) => s && s !== c;
    switch (n.kind) {
      case 'vsplit': case 'hsplit': {
        const vals = n.values.map((x) => x === FILL_REMAINING ? 'GUI_SPLIT_FILL_REMAINING' : x);
        L(`${KINDS[n.kind].fn}(&${v}, ${n.splitKind === 'absolute' ? 'GUI_SPLIT_ABSOLUTE' : 'GUI_SPLIT_RELATIVE'}, ${vals.length}${vals.map((x) => ', ' + x).join('')});`);
        break;
      }
      case 'fill': {
        const type = { plain: 'FILL_PLAIN', highlight: 'FILL_HIGHLIGHT', qr: 'FILL_QR' }[n.fillType];
        const c = n.fillType === 'plain' ? colorC(n.color) : n.fillType === 'highlight' ? 'gui_get_highlight_color()' : 'TFT_BLACK';
        L(`gui_make_fill(&${v}, ${c}, ${type}, NULL);`);
        if (n.fillType === 'plain' && twoColors(n.color, n.selectedColor)) L(`gui_set_colors(${v}, ${colorC(n.color)}, ${colorC(n.selectedColor)});`);
        break;
      }
      case 'button':
        events.add(n.event);
        L(`gui_make_button(&${v}, ${colorC(n.color)}, ${colorC(n.selectedColor || n.color)}, ${n.event}, NULL);`);
        if (n.initial) after.push(`gui_set_activity_initial_selection(${v});`);
        if (n.active === false) after.push(`gui_set_active(${v}, false);`);
        break;
      case 'text':
        if (n.font === 'GUI_DEFAULT_FONT') L(`gui_make_text(&${v}, ${cString(n.text.slice(0, 255))}, ${colorC(n.color)});`);
        else L(`gui_make_text_font(&${v}, ${cString(n.text.slice(0, 255))}, ${colorC(n.color)}, ${n.font});`);
        if (twoColors(n.color, n.selectedColor)) L(`gui_set_colors(${v}, ${colorC(n.color)}, ${colorC(n.selectedColor)});`);
        if (n.halign !== 'left' || n.valign !== 'top') L(`gui_set_align(${v}, GUI_ALIGN_${n.halign.toUpperCase()}, GUI_ALIGN_${n.valign.toUpperCase()});`);
        if (n.scroll) L(`gui_set_text_scroll(${v}, ${colorC(n.scrollBg)});`);
        break;
      case 'picture': {
        logos.add(n.logo);
        const s = logoSym(n.logo);
        L(`gui_make_picture(&${v}, get_picture(${s}_start, ${s}_end));`);
        if (n.halign !== 'left' || n.valign !== 'top') L(`gui_set_align(${v}, GUI_ALIGN_${n.halign.toUpperCase()}, GUI_ALIGN_${n.valign.toUpperCase()});`);
        break;
      }
      case 'qrguide':
        L(`gui_make_qrguide(&${v}, ${colorC(n.color)});`);
        break;
    }
    if (n.margins.some(Boolean)) L(`gui_set_margins(${v}, ${sidesC(n.margins)});`);
    if (n.padding.some(Boolean)) L(`gui_set_padding(${v}, ${sidesC(n.padding)});`);
    if (n.border) {
      const b = n.border;
      L(`gui_set_borders(${v}, ${colorC(b.color)}, ${b.thickness}, ${sidesNameC(b.sides)});`);
      if (b.selected && b.selected !== b.color) L(`gui_set_borders_selected_color(${v}, ${colorC(b.selected)});`);
      if (b.inactive && b.inactive !== b.color) L(`gui_set_borders_inactive_color(${v}, ${colorC(b.inactive)});`);
    }
    L(`gui_set_parent(${v}, ${parentName});`);
    for (const c of n.children) emit(c, v);
  }
  for (const c of design.root.children) emit(c, 'act->root_node');
  if (after.length) { L(); after.forEach((s) => L(s)); }
  L();
  L('return act;');

  const head = [
    '// Generated by the jade.church screen designer',
    `// Display: ${design.device === 'custom' ? 'custom' : DEVICES[design.device].label}, ${w} x ${h} px` +
      (design.statusBar ? `, status bar ${statusBarHeight()} px` : ''),
  ];
  if (design.device === 'custom') head.push(`// Set CONFIG_DISPLAY_WIDTH=${w} and CONFIG_DISPLAY_HEIGHT=${h} (Display Driver menu) for this layout.`);
  head.push('#include "../ui.h"', '');
  const customEvents = [...events].filter((e) => !buttonEvents.includes(e));
  if (customEvents.length) {
    head.push('// These event ids are not in button_events.h: add them to the BTN_ enum there.');
    customEvents.forEach((e) => head.push(`//   ${e},`));
    head.push('');
  }
  if (logos.size) {
    head.push('// Images from jade/logo: embed them with EMBED_FILES in main/CMakeLists.txt (as the existing logos are).');
    for (const f of logos) {
      const s = logoSym(f);
      head.push(`extern const uint8_t ${s}_start[] asm("_binary_${s}_start");`, `extern const uint8_t ${s}_end[] asm("_binary_${s}_end");`);
    }
    head.push('');
  }
  const usage = ['', '// Usage:', `//   gui_activity_t* const act = ${fn}();`, '//   gui_set_current_activity(act);'];
  if (events.size) {
    usage.push(`//   const int32_t ev_id = gui_activity_wait_button(act, ${[...events][0]});`, '//   switch (ev_id) {',
      ...[...events].map((e) => `//   case ${e}: /* ... */ break;`), '//   }');
  } else {
    usage.push('//   // no buttons: the screen stays until another activity replaces it');
  }
  return [...head, `gui_activity_t* ${fn}(void)`, '{', ...body, '}', ...usage, ''].join('\n');
}

const C_KEYWORDS = /\b(gui_activity_t|gui_view_node_t|const|void|return|extern|uint8_t|int32_t|true|false|NULL|switch|case|break)\b/g;
function highlightC(code) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return code.split('\n').map((line) => {
    const ci = line.indexOf('//');
    const codePart = ci >= 0 ? line.slice(0, ci) : line, comment = ci >= 0 ? line.slice(ci) : '';
    let html = '';
    const re = /("(?:\\.|[^"\\])*")|\/\*.*?\*\//g;
    let last = 0, m;
    const plain = (s) => esc(s)
      .replace(C_KEYWORDS, '<span class="k">$1</span>')
      .replace(/\b(gui_\w+|get_picture)(?=\()/g, '<span class="f">$1</span>')
      .replace(/\b(GUI_[A-Z0-9_]+|TFT_[A-Z]+|FILL_[A-Z]+|BTN_[A-Z0-9_]+|[A-Z0-9_]+_FONT|0x[0-9A-F]+)\b/g, '<span class="c">$1</span>');
    while ((m = re.exec(codePart))) {
      html += plain(codePart.slice(last, m.index));
      html += m[1] ? `<span class="s">${esc(m[0])}</span>` : `<span class="m">${esc(m[0])}</span>`;
      last = re.lastIndex;
    }
    html += plain(codePart.slice(last));
    if (line.startsWith('#')) html = `<span class="k">${esc(line)}</span>`;
    return html + (comment ? `<span class="m">${esc(comment)}</span>` : '');
  }).join('\n');
}
function renderCode() { $('#sd-code').innerHTML = highlightC(generateC()); }

// ---------------------------------------------------------------- page
function toast(msg) {
  const t = $('#sd-toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}

function syncSettings() {
  $('#sd-device').value = design.device;
  $('#sd-custom-size').hidden = design.device !== 'custom';
  $('#sd-width').value = design.width; $('#sd-height').value = design.height;
  $('#sd-statusbar').checked = design.statusBar;
  $('#sd-title').hidden = !design.statusBar; $('#sd-title').value = design.title;
  $('#sd-theme').value = String(design.theme);
  $('#sd-qr').value = String(design.qr);
  $('#sd-fn').value = design.fn;
  $('#sd-undo').disabled = !undoStack.length;
  $('#sd-redo').disabled = !redoStack.length;
}

function refresh() {
  syncSettings();
  renderScreen();
  renderTreeList();
  renderInspector();
  renderCode();
  try { localStorage.setItem(STORE_KEY, snapshot()); } catch { /* private mode */ }
}

function buildLibrary() {
  const nodes = $('#sd-lib-nodes'), blocks = $('#sd-lib-blocks');
  for (const p of PRIMITIVES) {
    const b = el('button', 'sd-lib-item'); b.type = 'button';
    b.append(el('span', `sd-kind sd-kind-${p.kind}`, p.label), el('span', 'sd-lib-note', p.note));
    b.title = KINDS[p.kind].help;
    b.onclick = () => insert(p.make());
    nodes.append(b);
  }
  for (const k of BLOCKS) {
    const b = el('button', 'sd-lib-item'); b.type = 'button';
    b.append(el('span', 'sd-lib-name', k.label), el('span', 'sd-lib-note', k.note));
    b.onclick = () => insert(k.make());
    blocks.append(b);
  }
  const preset = $('#sd-preset');
  for (const p of PRESETS) preset.append(new Option(p.label, p.id));
  preset.onchange = () => {
    const p = PRESETS.find((x) => x.id === preset.value);
    preset.value = '';
    if (!p) return;
    commit(() => {
      design.root.children = [];
      const sub = p.make();
      if (sub) design.root.children.push(sub);
      selectedId = sub ? sub.id : design.root.id;
    });
  };
  const guide = $('#sd-guide-nodes');
  for (const [kind, info] of Object.entries(KINDS)) {
    if (kind === 'root') continue;
    guide.append(el('dt', `sd-kind sd-kind-${kind}`, `${info.label}`), el('dd', null, info.help));
  }
  guide.append(el('dt', 'sd-kind', 'icon'), el('dd', null, 'gui_make_icon(): a 1-bit image drawn in a colour. Not in the designer: Jade\'s icons are built in code from assets.c.'));
  for (let i = 0; i < QR_COLORS.length; i++) $('#sd-qr').append(new Option(`#${rgb565ToCss(swap16(QR_COLORS[i])).map((v) => v.toString(16).padStart(2, '0')).join('')}${i === 1 ? ' (v1 default)' : i === 4 ? ' (v2 default)' : ''}`, String(i)));
}

function bind() {
  $('#sd-device').onchange = () => commit(() => {
    design.device = $('#sd-device').value;
    if (design.device !== 'custom') { design.width = DEVICES[design.device].w; design.height = DEVICES[design.device].h; design.qr = design.device === 'v2' ? 4 : 1; }
  });
  const size = () => commit(() => {
    design.width = Math.max(16, Math.min(640, Math.round(Number($('#sd-width').value) || 240)));
    design.height = Math.max(16, Math.min(640, Math.round(Number($('#sd-height').value) || 135)));
  });
  $('#sd-width').onchange = size; $('#sd-height').onchange = size;
  $('#sd-statusbar').onchange = () => commit(() => { design.statusBar = $('#sd-statusbar').checked; });
  $('#sd-title').onchange = () => commit(() => { design.title = $('#sd-title').value; });
  $('#sd-theme').onchange = () => commit(() => { design.theme = Number($('#sd-theme').value); });
  $('#sd-qr').onchange = () => commit(() => { design.qr = Number($('#sd-qr').value); });
  $('#sd-show-sel').onchange = () => { renderScreen(); };
  $('#sd-zoom').onchange = () => { renderScreen(); };
  let fitWidth = 0;
  new ResizeObserver(() => {
    const w = $('.sd-stage-wrap').clientWidth;
    if (w !== fitWidth && $('#sd-zoom').value === 'auto') { fitWidth = w; renderScreen(); }
  }).observe($('.sd-stage-wrap'));
  $('#sd-fn').onchange = () => commit(() => { design.fn = $('#sd-fn').value.replace(/[^A-Za-z0-9_]/g, '_') || 'make_my_screen_activity'; });
  $('#sd-undo').onclick = undo; $('#sd-redo').onclick = redo;
  $('#sd-up').onclick = () => move(-1); $('#sd-down').onclick = () => move(1);
  $('#sd-del').onclick = removeSelected; $('#sd-dup').onclick = duplicate; $('#sd-wrap').onclick = wrapInFill;

  canvas.onclick = (ev) => { const r = boxAt(ev); if (r?.hit) select(r.hit.node.id); };
  canvas.onmousemove = (ev) => {
    const r = boxAt(ev);
    $('#sd-hover').textContent = r ? `(${r.x}, ${r.y})` + (r.hit ? ` · ${r.hit.node.kind === 'root' ? 'root_node' : nodeLabel(r.hit.node)}` : '') : '\u00a0';
  };
  canvas.onmouseleave = () => { $('#sd-hover').textContent = '\u00a0'; };

  $('#sd-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(generateC()); toast('C code copied to the clipboard.'); } catch { toast('The browser did not allow copying: select the code and copy it.'); }
  };
  $('#sd-download').onclick = () => download(`${design.fn || 'screen'}.c`, generateC(), 'text/x-csrc');
  $('#sd-export').onclick = () => download(`${design.fn || 'screen'}.json`, JSON.stringify(design, null, 2), 'application/json');
  $('#sd-import').onclick = () => $('#sd-import-file').click();
  $('#sd-import-file').onchange = async () => {
    const f = $('#sd-import-file').files[0];
    $('#sd-import-file').value = '';
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (d?.root?.kind !== 'root') throw new Error('not a screen designer file');
      commit(() => { design = d; nextId = maxId(design.root) + 1; selectedId = design.root.id; });
    } catch (e) { toast(`Cannot open ${f.name}: ${e.message}`); }
  };

  document.addEventListener('keydown', (ev) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && !typing) { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'y' && !typing) { ev.preventDefault(); redo(); return; }
    if (typing) return;
    if (ev.key === 'Delete' || ev.key === 'Backspace') { if (findEntry(selectedId)?.parent) { ev.preventDefault(); removeSelected(); } return; }
    if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) { ev.preventDefault(); move(ev.key === 'ArrowUp' ? -1 : 1); return; }
    if (document.activeElement?.closest?.('#sd-tree') && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
      ev.preventDefault();
      const ids = [...walk(design.root)].map((e) => e.node.id), i = ids.indexOf(selectedId);
      select(ids[Math.max(0, Math.min(ids.length - 1, i + (ev.key === 'ArrowUp' ? -1 : 1)))]);
      $('#sd-tree .selected')?.focus();
    }
  });
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function init() {
  buildLibrary();
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved?.root?.kind === 'root') { design = saved; nextId = maxId(design.root) + 1; }
  } catch { /* ignore a broken save */ }
  if (!design) design = newDesign();
  selectedId = design.root.children[0]?.id ?? design.root.id;
  bind();
  refresh();
  // what the firmware checkout offers: logos, button events, and its revision
  fetch('/api/logos').then((r) => r.json()).then(({ logos }) => { if (logos?.length) { logoNames = logos; renderInspector(); } }).catch(() => {});
  fetch('/api/button-events').then((r) => r.json()).then(({ events }) => { if (events?.length) { buttonEvents = events; renderInspector(); renderCode(); } }).catch(() => {});
  fetch('/api/fonts').then((r) => r.json()).then(({ jade }) => {
    if (!jade) return;
    $('#sd-source').textContent = `gui library, fonts and logos from Jade ${jade.tags?.[0] || jade.describe || ''} (${jade.short})`;
    $('#sd-source').title = `${jade.commit}\n${jade.date || ''} · ${jade.subject || ''}`;
  }).catch(() => {});
}

init();
