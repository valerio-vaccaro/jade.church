// jade.church · pinserver: a QR code that points a Jade at the test pinserver, and its PIN records.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };

  // ---- QR payload: an update_pinserver RPC as CBOR, wrapped in a single-part BC-UR "jade-updps" ----
  // Minimal bytewords from jade/components/esp32_bc-ur/src/bytewords.cpp (first + last letter of each word)
  const BYTEWORDS = 'aeadaoaxaaahamatayasbkbdbnbtbabsbebybgbwbbbzcmchcscfcycwcecackctcxclcpcndkdadsdidedtdrdndwdpdmdldyeheyeoeeecenemetesftfrfnfsfmfhfzfpfwfxfyfefgflfdgagegrgsgtglgwgdgygmgughgohfhghdhkhthphhhlhyhehnhsidiaieihiyioisinimjejzjnjtjljojsjpjkjykpkoktkskkknkgkekikblblalylflslrlplnltloldlelulklgmnmymhmemomumwmdmtmsmknlnyndnsntnnnenboyoeotoxonolospdptpkpypspmplpepfpaprqdqzrerprlrorhrdrkrfryrnrsrtsesasrssskswstspsosgsbsfsntotktitttdtetytltbtstptatnuyuoutueurvtvyvovlvevwvavdvswlwdwmwpwewywswtwnwzwfwkykynylyaytzszoztzczezm';
  const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (bytes) => {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  function cbor(value) {
    const out = [];
    const head = (major, n) => {
      if (n < 24) out.push((major << 5) | n);
      else if (n < 0x100) out.push((major << 5) | 24, n);
      else if (n < 0x10000) out.push((major << 5) | 25, n >> 8, n & 0xff);
      else out.push((major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
    };
    const enc = (v) => {
      if (v === true || v === false) out.push(v ? 0xf5 : 0xf4);
      else if (typeof v === 'number') head(0, v);
      else if (typeof v === 'string') { const b = new TextEncoder().encode(v); head(3, b.length); out.push(...b); }
      else if (v instanceof Uint8Array) { head(2, v.length); out.push(...v); }
      else { const keys = Object.keys(v); head(5, keys.length); for (const k of keys) { enc(k); enc(v[k]); } }
    };
    enc(value);
    return new Uint8Array(out);
  }

  function urEncode(type, bytes) {
    const crc = crc32(bytes);
    const all = [...bytes, crc >>> 24, (crc >> 16) & 0xff, (crc >> 8) & 0xff, crc & 0xff];
    return `ur:${type}/` + all.map((b) => BYTEWORDS.substr(b * 2, 2)).join('');
  }

  const hexToBytes = (hex) => new Uint8Array((hex.match(/../g) || []).map((h) => parseInt(h, 16)));

  // ---- state ----
  let info = null;           // last /api/pinserver reply
  const open = new Set();    // record ids whose details are expanded
  let busy = false;

  function toast(msg, bad) {
    const t = $('ps-toast');
    t.textContent = msg;
    t.classList.toggle('bad', !!bad);
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  async function api(path, body) {
    const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  // ---- left column: QR ----
  function urlA() {
    const host = $('ps-host').value.trim();
    const port = $('ps-port').value.trim();
    const scheme = $('ps-scheme').value;
    const def = scheme === 'https' ? '443' : '80';
    const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;   // IPv6 literal
    return `${scheme}://${h}${port && port !== def ? ':' + port : ''}`;
  }

  function renderQr() {
    const reset = document.querySelector('input[name="ps-mode"]:checked').value === 'reset';
    $('ps-fields').hidden = reset;
    const err = $('ps-error');
    err.hidden = true;
    let params;
    if (reset) {
      params = { reset_details: true };
    } else {
      const a = urlA();
      const b = $('ps-urlb').value.trim();
      const problems = [];
      if (!$('ps-host').value.trim()) problems.push('enter a host');
      if (a.length >= 120) problems.push('the URL is longer than the 119 characters a Jade accepts');
      if (b && !/^https?:\/\//.test(b)) problems.push('the second URL must start with http:// or https://');
      if (b.length >= 120) problems.push('the second URL is longer than 119 characters');
      if ($('ps-pubkey').checked && info && !info.pubkey) problems.push('the server public key is not available');
      if (problems.length) {
        err.textContent = 'Cannot make the QR code: ' + problems.join('; ') + '.';
        err.hidden = false;
      }
      params = { urlA: a };
      if (b) params.urlB = b;
      if ($('ps-pubkey').checked && info && info.pubkey) params.pubkey = hexToBytes(info.pubkey);
    }
    const ur = urEncode('jade-updps', cbor({ id: 'qr', method: 'update_pinserver', params })).toUpperCase();
    const qr = window.QRCode.encode(ur, 'M');
    const canvas = $('ps-qr');
    window.QRCode.draw(canvas, qr, Math.max(2, Math.floor(300 / (qr.size + 8))), 4);
    canvas.classList.toggle('ps-qr-bad', !err.hidden);
    $('ps-qr-info').textContent = `BC-UR jade-updps · QR version ${qr.version} (${qr.size}×${qr.size}), error correction ${qr.ecl}`;
    $('ps-ur').textContent = ur;
    const rpc = {};
    for (const [k, v] of Object.entries(params)) rpc[k] = v instanceof Uint8Array ? 'hex:' + info.pubkey : v;
    $('ps-rpc').textContent = JSON.stringify(rpc, null, 2);
  }

  // ---- right column: records ----
  const fmtTime = (t) => (t ? new Date(t * 1000).toLocaleString() : '—');
  function ago(t) {
    if (!t) return '—';
    const s = Math.max(0, Date.now() / 1000 - t);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  }
  const lastEvent = (r) => (r.events && r.events.length ? r.events[r.events.length - 1] : null);

  function stateOf(r) {
    if (!r.exists) return ['deleted', 'ps-state-gone', 'the pinserver no longer has this record; only its request log is left'];
    if (r.error) return ['unreadable', 'ps-state-bad', r.error];
    if (r.hmac_ok === false) return ['corrupt', 'ps-state-bad', 'the record fails its HMAC check'];
    if (r.decrypted) {
      if (r.wrong_attempts > 0) return [`${r.tries_left} ${r.tries_left === 1 ? 'try' : 'tries'} left`, 'ps-state-warn', ''];
      return ['active', 'ps-state-ok', ''];
    }
    return ['encrypted', 'ps-state-locked', 'PIN public key not seen yet: the Jade has not used this record since logging started'];
  }

  function attemptsCell(r) {
    if (!r.exists) return '—';
    if (!r.decrypted) return el('span', { className: 'muted', title: 'decrypted after the next request from this Jade' }, '?');
    const wrap = el('span', { className: 'ps-dots', title: `${r.wrong_attempts} wrong PIN${r.wrong_attempts === 1 ? '' : 's'} of 3` });
    for (let i = 0; i < 3; i++) wrap.append(el('i', { className: i < r.wrong_attempts ? 'on' : '' }));
    wrap.append(` ${r.wrong_attempts}/3`);
    return wrap;
  }

  function actions(r) {
    const box = el('span', { className: 'ps-actions' });
    if (r.exists) {
      const reset = el('button', { type: 'button', textContent: 'Allow 3 more tries' });
      if (!r.decrypted) { reset.disabled = true; reset.title = 'needs the PIN public key, learnt on the next request from this Jade'; }
      else if (!r.wrong_attempts) { reset.disabled = true; reset.title = 'no wrong PIN to forgive'; }
      else reset.title = `reset the wrong PIN count (${r.wrong_attempts}) to 0`;
      reset.onclick = (e) => { e.stopPropagation(); act('reset', r); };
      box.append(reset);
    }
    const del = el('button', { type: 'button', className: 'danger', textContent: r.exists ? 'Delete' : 'Forget log' });
    del.title = r.exists ? 'delete the record now: that Jade can no longer unlock with its PIN' : 'delete the request log';
    del.onclick = (e) => { e.stopPropagation(); act('delete', r); };
    box.append(del);
    return box;
  }

  function details(r) {
    const dl = el('dl', { className: 'ps-dl' });
    const row = (k, v, mono) => {
      dl.append(el('dt', {}, k), el('dd', { className: mono ? 'mono' : '' }, v == null || v === '' ? '—' : String(v)));
    };
    row('Record id', r.id, true);
    row('File', r.exists ? `${r.id}.pin, ${r.size} bytes` : 'deleted');
    row('PIN public key', r.pin_pubkey || 'unknown until this Jade makes a request', !!r.pin_pubkey);
    if (r.exists) {
      row('Format', r.version != null ? `${r.version} (${r.format})` : null);
      row('Integrity', r.hmac_ok == null ? 'not checked' : r.hmac_ok ? 'HMAC valid' : 'HMAC does not match');
      if (r.decrypted) {
        row('Wrong PINs', `${r.wrong_attempts} of 3 · ${r.tries_left} left before the record is deleted`);
        row('Anti-replay counter', r.replay_counter != null ? r.replay_counter : 'none (format 0)');
        row('sha256(PIN secret)', r.hash_pin_secret, true);
        row('Stored AES key', r.aes_key, true);
      }
      row('HMAC', r.hmac, true);
      row('IV', r.iv, true);
      row('Ciphertext', r.ciphertext, true);
      row('File changed', fmtTime(r.modified));
    }
    if (r.error) row('Problem', r.error);
    row('First seen', fmtTime(r.first_seen));
    row('Last seen', fmtTime(r.last_seen));
    const box = el('div', { className: 'ps-detail' }, dl);
    if (r.events && r.events.length) {
      const tb = el('tbody');
      for (const e of [...r.events].reverse()) {
        tb.append(el('tr', {},
          el('td', {}, fmtTime(e.time)), el('td', {}, e.op), el('td', { className: resultClass(e.result) }, e.result),
          el('td', {}, e.protocol || ''), el('td', {}, e.replay_counter != null ? String(e.replay_counter) : ''),
          el('td', {}, e.ip || '')));
      }
      box.append(el('h3', {}, `Request log (${r.events.length})`),
        el('table', { className: 'ps-log' },
          el('thead', {}, el('tr', {}, ...['Time', 'Request', 'Result', 'Protocol', 'Counter', 'From'].map((h) => el('th', { scope: 'col' }, h)))), tb));
    } else {
      box.append(el('p', { className: 'muted small' }, 'No requests logged for this record yet.'));
    }
    return box;
  }

  function resultClass(res) {
    if (/correct|PIN set|reset/.test(res)) return 'ps-ok';
    if (/wrong|refused|no record/.test(res)) return 'ps-bad';
    return '';
  }

  function renderRecords() {
    const rows = $('ps-rows');
    rows.replaceChildren();
    const recs = info.records;
    $('ps-empty').hidden = recs.length > 0;
    const live = recs.filter((r) => r.exists).length;
    $('ps-count').textContent = recs.length ? String(live) : '';
    $('ps-count').title = `${live} stored${recs.length > live ? `, ${recs.length - live} deleted (log only)` : ''}`;
    for (const r of recs) {
      const [label, cls, why] = stateOf(r);
      const ev = lastEvent(r);
      const tr = el('tr', { className: 'ps-row' + (open.has(r.id) ? ' open' : ''), tabIndex: 0 },
        el('td', { className: 'mono', title: r.id }, el('span', { className: 'ps-caret' }, '▸'), r.id.slice(0, 12) + '…'),
        el('td', {}, el('span', { className: 'ps-state ' + cls, title: why }, label)),
        el('td', {}, attemptsCell(r)),
        el('td', {}, ev ? el('span', { className: resultClass(ev.result) }, `${ev.op}: ${ev.result}`) : el('span', { className: 'muted' }, '—')),
        el('td', { title: fmtTime(r.last_seen || r.modified) }, ago(r.last_seen || r.modified)),
        el('td', {}, actions(r)));
      const toggle = () => { if (open.has(r.id)) open.delete(r.id); else open.add(r.id); renderRecords(); };
      tr.onclick = toggle;
      tr.onkeydown = (e) => { if (e.target === tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(); } };
      tr.setAttribute('aria-expanded', open.has(r.id));
      rows.append(tr);
      if (open.has(r.id)) rows.append(el('tr', { className: 'ps-detail-row' }, el('td', { colSpan: 6 }, details(r))));
    }
    $('ps-folder').textContent = `Records in ${info.folder}` + (info.can_decrypt ? '' : ` · cannot decrypt: ${info.missing || 'server key not found'}`);
  }

  async function act(kind, r) {
    if (busy) return;
    const short = r.id.slice(0, 12) + '…';
    if (kind === 'delete' && r.exists && !confirm(`Delete PIN record ${short}?\n\nThe Jade that uses it will no longer unlock with its PIN and will have to be restored from its recovery phrase.`)) return;
    busy = true;
    try {
      const j = await api(`/api/pinserver/${kind}`, { id: r.id });
      toast(kind === 'reset' ? `Record ${short}: wrong PIN count ${j.was} → 0` : `Deleted ${j.removed.join(', ')}`);
      if (kind === 'delete') open.delete(r.id);
    } catch (e) {
      toast(e.message, true);
    } finally {
      busy = false;
      refresh();
    }
  }

  async function refresh() {
    try {
      info = await api('/api/pinserver');
    } catch (e) {
      $('ps-status').textContent = `cannot load: ${e.message}`;
      return;
    }
    const st = $('ps-status');
    st.textContent = info.running ? `running · ${info.url}` : info.url ? `not reachable · ${info.url}` : 'not started (see --pinserver-port)';
    st.className = 'small ' + (info.running ? 'ps-ok' : 'ps-bad');
    if (!refresh.portSet && info.port > 0) { $('ps-port').value = info.port; refresh.portSet = true; }
    renderRecords();
    renderQr();
    loadMessages();
  }

  // ---- tabs ----
  const TABS = ['records', 'messages'];
  function selectTab(name, focus) {
    for (const t of TABS) {
      const on = t === name;
      const tab = $(`ps-tab-${t}`);
      tab.setAttribute('aria-selected', on);
      tab.tabIndex = on ? 0 : -1;
      $(`ps-panel-${t}`).hidden = !on;
      if (on && focus) tab.focus();
    }
    history.replaceState(null, '', name === 'records' ? location.pathname : `#${name}`);
    if (name === 'messages') { loadMessages(); scrollMessages(); }
  }
  TABS.forEach((t, i) => {
    const tab = $(`ps-tab-${t}`);
    tab.onclick = () => selectTab(t);
    tab.onkeydown = (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (d) { e.preventDefault(); selectTab(TABS[(i + d + TABS.length) % TABS.length], true); }
    };
  });
  const messagesShown = () => !$('ps-panel-messages').hidden;

  // ---- messages ----
  const LABELS = {
    protocol: 'protocol', cke: 'cke · Jade ephemeral public key', ske: 'ske · server ephemeral public key',
    sig: 'signature of ske by the static server key', replay_counter: 'anti-replay counter',
    encrypted_data: 'encrypted payload', hmac_encrypted_data: 'HMAC of the payload', encrypted_key: 'encrypted key',
    hmac: 'HMAC of the key', pin_secret: 'PIN secret', entropy: 'entropy from the Jade (new PIN only)',
    signature: 'signature by the PIN private key', pin_pubkey: 'PIN public key', record: 'record id',
    aes_key: 'key sent to the Jade', outcome: 'outcome', body: 'body',
  };
  let msgs = [];
  const msgKey = (m) => `${m.time}|${m.dir}|${m.kind}|${m.title}`;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  function stamp(t) {
    const d = new Date(t * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  }

  function msgNode(m) {
    const wire = m.kind === 'wire';
    const head = el('div', { className: 'ps-msg-head' },
      el('time', { dateTime: new Date(m.time * 1000).toISOString() }, stamp(m.time)),
      el('span', { className: 'ps-dir', title: m.dir === 'in' ? 'Jade → pinserver' : 'pinserver → Jade' }, m.dir === 'in' ? '→ in' : '← out'),
      el('span', { className: 'ps-key ' + (wire ? 'ps-key-wire' : 'ps-key-dec') }, wire ? 'encrypted' : 'decrypted'),
      el('span', { className: 'ps-msg-title' }, m.title + (m.status && m.status !== 200 ? ` · HTTP ${m.status}` : '')));
    const dl = el('dl', { className: 'ps-msg-fields' });
    for (const [k, v] of Object.entries(m.fields || {})) {
      dl.append(el('dt', {}, LABELS[k] || k), el('dd', { className: k === 'outcome' || k === 'protocol' ? '' : 'mono' }, typeof v === 'object' ? JSON.stringify(v) : String(v)));
    }
    if (!dl.children.length) dl.append(el('dt', {}, 'body'), el('dd', { className: 'muted' }, '(empty)'));
    return el('div', { className: `ps-msg ${wire ? 'ps-msg-wire' : 'ps-msg-dec'}` }, head, dl);
  }

  function groupNode(m) {
    const name = m.endpoint || '?';
    return el('div', { className: 'ps-msg-group' },
      el('span', { className: 'ps-msg-endpoint' }, `#${m.req ?? '–'} ${name}`),
      m.ip ? el('span', { className: 'muted' }, ` from ${m.ip}`) : null);
  }

  function appendMessages(list, from) {
    const box = $('ps-msgs');
    const frag = document.createDocumentFragment();
    for (let i = from; i < list.length; i++) {
      const m = list[i], prev = list[i - 1];
      if (!prev || prev.run !== m.run || prev.req !== m.req) frag.append(groupNode(m));
      frag.append(msgNode(m));
    }
    box.append(frag);
  }

  function scrollMessages() {
    if ($('ps-follow').checked) { const box = $('ps-msgs'); box.scrollTop = box.scrollHeight; }
  }

  async function loadMessages() {
    let list;
    try { list = (await api('/api/pinserver/messages')).messages; } catch (e) { return; }
    const lastOld = msgs.length ? msgKey(msgs[msgs.length - 1]) : null;
    let from = -1;
    if (!msgs.length) from = 0;
    else if (list.length && msgKey(list[0]) === msgKey(msgs[0]) && list.length >= msgs.length && msgKey(list[msgs.length - 1]) === lastOld) from = msgs.length;
    if (from < 0) { $('ps-msgs').replaceChildren(); from = 0; }
    if (from === list.length && from === msgs.length && from > 0) return;   // nothing new
    msgs = list;
    appendMessages(list, from);
    const n = new Set(list.map((m) => `${m.run}-${m.req}`)).size;
    $('ps-msg-count').textContent = list.length ? String(n) : '';
    $('ps-msg-count').title = `${n} exchanges, ${list.length} messages`;
    $('ps-msg-empty').hidden = list.length > 0;
    if (messagesShown()) scrollMessages();
  }

  function filterMessages() {
    const box = $('ps-msgs');
    box.classList.toggle('hide-wire', !$('ps-show-wire').checked);
    box.classList.toggle('hide-dec', !$('ps-show-dec').checked);
  }
  $('ps-show-wire').onchange = filterMessages;
  $('ps-show-dec').onchange = filterMessages;
  $('ps-follow').onchange = scrollMessages;
  $('ps-msg-clear').onclick = async () => {
    if (!confirm('Clear the pinserver message log?')) return;
    try {
      await api('/api/pinserver/messages/clear', {});
      msgs = [];
      $('ps-msgs').replaceChildren();
      loadMessages();
    } catch (e) { toast(e.message, true); }
  };

  for (const id of ['ps-scheme', 'ps-host', 'ps-port', 'ps-urlb', 'ps-pubkey']) $(id).addEventListener('input', renderQr);
  document.querySelectorAll('input[name="ps-mode"]').forEach((r) => r.addEventListener('change', renderQr));
  $('ps-refresh').onclick = refresh;
  $('ps-copy-ur').onclick = () => navigator.clipboard.writeText($('ps-ur').textContent).then(() => toast('Copied'), () => toast('Copy failed', true));
  renderQr();
  refresh();
  if (location.hash === '#messages') selectTab('messages');
  setInterval(() => { if (!document.hidden && !busy) refresh(); }, 5000);
  setInterval(() => { if (!document.hidden && messagesShown()) loadMessages(); }, 2000);
})();
