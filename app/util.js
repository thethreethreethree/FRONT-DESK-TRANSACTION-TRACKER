// util.js — shared helpers: currency, dates, DOM, ids, and a self-contained
// SHA-256 (so ledger hash-chaining works offline, file://, no secure context).

// ---------------------------------------------------------------------------
// Currency (Philippine Peso). The whole system is peso-denominated.
// ---------------------------------------------------------------------------
const PESO = new Intl.NumberFormat('en-PH', {
  style: 'currency', currency: 'PHP', minimumFractionDigits: 2,
});
export const peso = (n) => PESO.format(Number(n || 0));
export const pesoPlain = (n) =>
  Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------------------------------------------------------------------------
// Dates / time
// ---------------------------------------------------------------------------
export const nowISO = () => new Date().toISOString();

export function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString('en-PH', {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}
export function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: '2-digit' });
}
export function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });
}
// Business date = the calendar date in local time (YYYY-MM-DD), used to group shifts.
export function businessDate(iso = nowISO()) {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
// Guess the current shift from the local hour: AM 06–14, PM 14–22, GY 22–06.
export function guessShift(iso = nowISO()) {
  const h = new Date(iso).getHours();
  if (h >= 6 && h < 14) return 'AM';
  if (h >= 14 && h < 22) return 'PM';
  return 'GY';
}

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------
let _counter = 0;
export function uid(prefix = 'id') {
  _counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${_counter.toString(36)}_${rand}`;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') node.value = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

// ---------------------------------------------------------------------------
// Towel tag numbers
// ---------------------------------------------------------------------------
// The "Towel" item (NOT "Beach Towel", padlock or hair dryer) carries a physical
// tag number the guest leaves at the desk. New entries store it in `entry.towelNo`;
// historical entries hold it inside the free-text note — imported deposits as
// "tags #193 · PM SHIFT …" and hand-typed ones as a bare "#75" / "#209 and #4".
// We never rewrite those notes (it would break the ledger hash chain), so these
// helpers READ the number from whichever place holds it and show it in one field.

// Only the item literally named "Towel" tracks a tag number — "Beach Towel" does not.
export function isTowelItem(name) {
  return String(name || '').trim().toLowerCase() === 'towel';
}

// The "Passport" item is a non-cash deposit: ₱0 value, a MEWS reservation # is
// required, and the passport itself is held until returned.
export function isPassportItem(name) {
  return String(name || '').trim().toLowerCase() === 'passport';
}

const tidyTowelNo = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);

// Pull a towel tag number out of a legacy note. Returns '' when there isn't one.
export function towelNoFromNote(note) {
  const raw = String(note || '').trim();
  if (!raw) return '';
  const seg = raw.split('·')[0].trim(); // the number sits before the first separator
  // Imported deposits: "tags #193", "tags new #87/97", "tags 205".
  const m = seg.match(/^tags\b\s*(?:new\b\s*)?(.+)$/i);
  if (m) return tidyTowelNo(m[1]);
  // Hand-typed deposits where the note itself is the tag: "#75", "#209 and #4".
  // Conservative: must start with '#' or be purely numeric so prose like
  // "excess" or "PM SHIFT APRIL" is never mistaken for a tag number.
  if (/^#/.test(seg) || /^\d+(\s*\/\s*\d+)*$/.test(seg)) return tidyTowelNo(seg);
  return '';
}

// The towel number to display for a ledger entry: the explicit field when set,
// otherwise parsed from the legacy note. Only meaningful for the Towel item.
export function entryTowelNo(e) {
  if (!e) return '';
  if (e.towelNo != null && String(e.towelNo).trim()) return tidyTowelNo(e.towelNo);
  if (isTowelItem(e.itemName)) return towelNoFromNote(e.note);
  return '';
}

// Split a towel-number string into individual tag tokens for inventory matching.
// One deposit can release several towels: "#87/97" -> ["87","97"], "1, 2 and 3"
// -> ["1","2","3"], "#B-094" -> ["B-094"]. A token must contain a digit, so prose
// the note parser may have caught ("not sure", "no number yet") is dropped here.
export function towelTokens(str) {
  if (!str) return [];
  const out = [];
  const parts = String(str).replace(/#/g, ' ').replace(/\band\b/gi, ' ').split(/[\/,]+|\s+/);
  for (const p of parts) {
    const t = p.trim().toUpperCase();
    if (t && t.length <= 12 && /\d/.test(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

// Normalise a single towel number the same way towelTokens does (for lookups and
// for the inventory master list), so "#7" / " 7 " / "7" all key to "7".
export function normTowelNo(no) {
  const t = towelTokens(no);
  return t.length ? t[0] : String(no || '').trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// Toast notifications
// ---------------------------------------------------------------------------
export function toast(msg, kind = 'ok') {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = el('div', { id: 'toast-host', class: 'toast-host' });
    document.body.appendChild(host);
  }
  const t = el('div', { class: `toast toast-${kind}`, text: msg });
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 250);
  }, 3200);
}

// ---------------------------------------------------------------------------
// SHA-256 — standard, dependency-free, synchronous, UTF-8 safe. Used for the
// tamper-evident ledger hash chain. Verified against FIPS-180 test vectors.
// ---------------------------------------------------------------------------
const _K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function _utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
    else if (c >= 0xd800 && c <= 0xdbff) { // surrogate pair
      const c2 = str.charCodeAt(++i);
      c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
  }
  return out;
}

export function sha256(message) {
  const bytes = _utf8Bytes(String(message));
  const l = bytes.length;
  // padding: append 0x80, then zeros, then 64-bit big-endian bit length
  const withPad = bytes.slice();
  withPad.push(0x80);
  while (withPad.length % 64 !== 56) withPad.push(0x00);
  const bitLen = l * 8;
  for (let i = 7; i >= 0; i--) withPad.push((bitLen / Math.pow(2, i * 8)) & 0xff);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = (withPad[off + i * 4] << 24) | (withPad[off + i * 4 + 1] << 16)
        | (withPad[off + i * 4 + 2] << 8) | (withPad[off + i * 4 + 3]);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + _K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }

  let hex = '';
  for (let i = 0; i < 8; i++) hex += (H[i] >>> 0).toString(16).padStart(8, '0');
  return hex;
}

// Convenience: hash a JS object stably (sorted keys) -> hex string.
export function hashObject(obj) {
  return sha256(stableStringify(obj));
}
export function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}
