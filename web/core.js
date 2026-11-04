// 出席カードの中核処理（attendance_code.py と同じ方式・互換）
//   コード = Crockford Base32( nonce(4B) | 暗号文(5B) | タグ(4B) )
//   暗号文 = [日付(2B) | 番号(2B) | 授業ID(1B)] XOR HMAC-SHA256(key, "enc"+nonce)[:5]
//   タグ   = HMAC-SHA256(key, "tag"+nonce+暗号文)[:4]
// 外部ライブラリ・通信なし。SHA-256 も自前実装（file:// で開いても動くように）。
(function (root) {
  "use strict";

  // ---------- SHA-256 / HMAC ----------
  const K = new Uint32Array(64);
  const H0 = new Uint32Array(8);
  (function initConstants() {
    const primes = [];
    for (let n = 2; primes.length < 64; n++) {
      if (primes.every(p => n % p !== 0)) primes.push(n);
    }
    const frac = x => ((x - Math.floor(x)) * 2 ** 32) >>> 0;
    primes.forEach((p, i) => { K[i] = frac(Math.cbrt(p)); });
    primes.slice(0, 8).forEach((p, i) => { H0[i] = frac(Math.sqrt(p)); });
  })();

  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  function sha256(msg) {
    const len = msg.length;
    const padded = ((len + 9 + 63) >> 6) << 6;
    const buf = new Uint8Array(padded);
    buf.set(msg);
    buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(padded - 8, Math.floor(len / 2 ** 29));
    dv.setUint32(padded - 4, (len * 8) >>> 0);
    const h = Uint32Array.from(H0);
    const w = new Uint32Array(64);
    for (let off = 0; off < padded; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + 4 * i);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      [a, b, c, d, e, f, g, hh].forEach((x, i) => { h[i] = (h[i] + x) >>> 0; });
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    h.forEach((x, i) => odv.setUint32(4 * i, x));
    return out;
  }

  function concat(...arrs) {
    const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0));
    let p = 0;
    for (const a of arrs) { out.set(a, p); p += a.length; }
    return out;
  }

  function hmacSha256(key, msg) {
    let k = key.length > 64 ? sha256(key) : key;
    const kp = new Uint8Array(64);
    kp.set(k);
    const ipad = kp.map(x => x ^ 0x36);
    const opad = kp.map(x => x ^ 0x5c);
    return sha256(concat(opad, sha256(concat(ipad, msg))));
  }

  const ascii = s => Uint8Array.from(s, c => c.charCodeAt(0));
  const LABEL_ENC = ascii("enc");
  const LABEL_TAG = ascii("tag");
  const mac = (key, label, data) => hmacSha256(key, concat(label, data));

  // ---------- 鍵 ----------
  function parseKeyHex(text) {
    const hex = String(text).trim();
    if (!/^([0-9a-fA-F]{2})+$/.test(hex)) return null;
    return Uint8Array.from(hex.match(/../g), h => parseInt(h, 16));
  }

  function randomBytes(n) {
    const b = new Uint8Array(n);
    (root.crypto || require("crypto").webcrypto).getRandomValues(b);
    return b;
  }

  function newKeyHex() {
    return Array.from(randomBytes(32), b => b.toString(16).padStart(2, "0")).join("");
  }

  // ---------- Base32 ----------
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford（I,L,O,U なし）
  const NBYTES = 13;
  const NCHAR = Math.ceil(NBYTES * 8 / 5); // 21
  const SHIFT = BigInt(NCHAR * 5 - NBYTES * 8); // 1

  function b32encode(bytes) {
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    n <<= SHIFT;
    let s = "";
    for (let i = NCHAR - 1; i >= 0; i--) s += ALPHABET[Number((n >> BigInt(5 * i)) & 31n)];
    const groups = [s.slice(0, 5)];
    for (let i = 5; i < s.length; i += 4) groups.push(s.slice(i, i + 4));
    return groups.join("-");
  }

  function b32decode(str) {
    const s = String(str).toUpperCase().replace(/[- ]/g, "")
      .replace(/O/g, "0").replace(/[IL]/g, "1"); // 読み間違い対策
    if (s.length !== NCHAR) return null;
    let n = 0n;
    for (const c of s) {
      const v = ALPHABET.indexOf(c);
      if (v < 0) return null;
      n = n * 32n + BigInt(v);
    }
    n >>= SHIFT;
    const out = new Uint8Array(NBYTES);
    for (let i = NBYTES - 1; i >= 0; i--) { out[i] = Number(n & 255n); n >>= 8n; }
    return out;
  }

  // ---------- 日付（2020-01-01 からの日数。0 は「日付なし」） ----------
  const EPOCH_MS = Date.UTC(2020, 0, 1);
  const DAY_MS = 86400000;

  function dateToDays(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return NaN;
    return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - EPOCH_MS) / DAY_MS);
  }

  function daysToDate(days) {
    return new Date(EPOCH_MS + days * DAY_MS).toISOString().slice(0, 10);
  }

  function todayISO() {
    const t = new Date();
    const p = x => String(x).padStart(2, "0");
    return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
  }

  function addDays(iso, n) {
    return daysToDate(dateToDays(iso) + n);
  }

  // ---------- 暗号化・復号 ----------
  // date: "YYYY-MM-DD" または null（日付なしカード）
  function encode(key, date, number, course, nonce) {
    const days = date === null ? 0 : dateToDays(date);
    if (!(date === null || (days > 0 && days < 65536))) throw new Error("日付が範囲外です: " + date);
    if (!(Number.isInteger(number) && number >= 0 && number < 65536)) throw new Error("番号は 0〜65535 です");
    if (!(Number.isInteger(course) && course >= 0 && course < 256)) throw new Error("授業IDは 0〜255 です");
    nonce = nonce || randomBytes(4);
    const plain = Uint8Array.of(days >> 8, days & 255, number >> 8, number & 255, course);
    const stream = mac(key, LABEL_ENC, nonce).slice(0, 5);
    const cipher = plain.map((x, i) => x ^ stream[i]);
    const tag = mac(key, LABEL_TAG, concat(nonce, cipher)).slice(0, 4);
    return b32encode(concat(nonce, cipher, tag));
  }

  // {date: "YYYY-MM-DD" | null, number, course} を返す。不正なコードなら null。
  function decode(key, code) {
    const raw = b32decode(code);
    if (!raw) return null;
    const nonce = raw.slice(0, 4), cipher = raw.slice(4, 9), tag = raw.slice(9);
    const expect = mac(key, LABEL_TAG, concat(nonce, cipher)).slice(0, 4);
    let diff = 0;
    for (let i = 0; i < 4; i++) diff |= tag[i] ^ expect[i];
    if (diff !== 0) return null;
    const stream = mac(key, LABEL_ENC, nonce).slice(0, 5);
    const p = cipher.map((x, i) => x ^ stream[i]);
    const days = (p[0] << 8) | p[1];
    return { date: days === 0 ? null : daysToDate(days), number: (p[2] << 8) | p[3], course: p[4] };
  }

  // セル内の文字列（URL が丸ごと入っていても可）からコードを取り出す。
  // URL の場合，フォームID（1FAIpQ...）もコードの形に一致するので，末尾にある最後の一致を使う。
  const CODE_RE = /[0-9A-Za-z]{5}(?:-?[0-9A-Za-z]{4}){4}/g;
  function extractCode(text) {
    let t = String(text || "");
    try { t = decodeURIComponent(t); } catch (e) { /* そのまま */ }
    const ms = t.match(CODE_RE);
    return ms ? ms[ms.length - 1] : null;
  }

  // ---------- CSV ----------
  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = [];
    let row = [], field = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
        } else field += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => !(r.length === 1 && r[0] === "")); // 空行は飛ばす
  }

  function toCSV(rows) {
    const cell = v => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return rows.map(r => r.map(cell).join(",")).join("\r\n") + "\r\n";
  }

  // ---------- 授業ID表（courses.csv: id,name） ----------
  function parseCourses(text) {
    const rows = parseCSV(text);
    if (!rows.length) return {};
    const h = rows[0].map(s => s.trim());
    const iId = h.indexOf("id"), iName = h.indexOf("name");
    if (iId < 0 || iName < 0) throw new Error("courses.csv の見出しは id,name にしてください");
    const out = {};
    for (const r of rows.slice(1)) {
      const id = parseInt(r[iId], 10);
      if (Number.isInteger(id)) out[id] = r[iName] || "";
    }
    return out;
  }

  function coursesToCSV(courses) {
    const ids = Object.keys(courses).map(Number).sort((a, b) => a - b);
    return toCSV([["id", "name"], ...ids.map(i => [i, courses[i]])]);
  }

  // ---------- 回答CSVのデコード（attendance_code.py decode と同じ出力） ----------
  // column: 列番号。null なら自動検出（コードらしき値が最も多い列）
  function decodeResponses(key, rows, courses, column) {
    const header = rows[0], body = rows.slice(1);
    let col = column;
    if (col === null || col === undefined) {
      let best = -1;
      header.forEach((_, j) => {
        const n = body.filter(r => j < r.length && extractCode(r[j])).length;
        if (n > best) { best = n; col = j; }
      });
    }
    const seen = new Map();
    const out = [header.concat(["日付", "カードNo", "授業ID", "授業名", "判定"])];
    body.forEach((r, i) => {
      const code = col < r.length ? extractCode(r[col]) : null;
      const res = code ? decode(key, code) : null;
      if (!res) { out.push(r.concat(["", "", "", "", "不正コード"])); return; }
      const k = `${res.date}|${res.number}|${res.course}`;
      const status = seen.has(k) ? `重複（${seen.get(k) + 2}行目と同じカード）` : "OK";
      if (!seen.has(k)) seen.set(k, i);
      out.push(r.concat([res.date || "なし", res.number, res.course, courses[res.course] || "", status]));
    });
    return { column: col, rows: out };
  }

  const api = {
    sha256, hmacSha256, parseKeyHex, newKeyHex, randomBytes,
    b32encode, b32decode, encode, decode, extractCode,
    dateToDays, daysToDate, todayISO, addDays,
    parseCSV, toCSV, parseCourses, coursesToCSV, decodeResponses,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AttendanceCore = api;
})(typeof window !== "undefined" ? window : globalThis);
