'use strict';
/* ════════════════════════════════════════════════════════════════
   Hash verify helpers (spec §8), pure JS and DOM-free (tests/hashes.test.mjs).

   detectHashAlgo(text) → { algo, hex } | null
     What a pasted "expected hash" is, from its length alone:
       32 hex → MD5 · 40 → SHA-1 · 64 → SHA-256 · 128 → SHA-512
     It trims, keeps the first line, takes the hex out of a BSD line
     ("SHA256 (name) = <hex>"), drops an "algo:" / "sha256=" style prefix,
     keeps the first token of a sha256sum line ("<hex>  name" or "<hex> *name")
     and ignores case. A prefix that names another algorithm than the length
     says is refused (null), as is anything that is not 32/40/64/128 hex.

   An incremental MD5 (RFC 1321) in the style of js/lib/sha256.js, so a file
   of any size streams through it a slice at a time:
     const st = md5Init();
     md5Update(st, uint8array);   // as many times as needed
     md5Digest(st);               // → lowercase hex, 32 chars
   MD5 is broken for security; it is here only because download pages still
   publish MD5 sums to check against.
   ════════════════════════════════════════════════════════════════ */

function detectHashAlgo(text){
  let s = String(text == null ? '' : text).trim();
  if(!s) return null;
  s = s.split(/\r?\n/)[0].trim();
  const BY_LEN = { 32: 'MD5', 40: 'SHA-1', 64: 'SHA-256', 128: 'SHA-512' };
  // "md5", "MD-5", "sha256", "SHA-256", "sha_512" → the canonical name.
  const named = (n) => {
    const k = String(n || '').toLowerCase().replace(/[-_\s]/g, '');
    return ({ md5: 'MD5', sha1: 'SHA-1', sha256: 'SHA-256', sha512: 'SHA-512' })[k] || null;
  };
  let declared = null;
  // BSD style: SHA256 (file.iso) = <hex>
  const bsd = s.match(/^([a-z][a-z0-9_-]{1,9})\s*\(.*\)\s*=\s*(\S+)$/i);
  if(bsd){ declared = named(bsd[1]); if(!declared) return null; s = bsd[2]; }
  else {
    // A prefix: "sha256:<hex>", "SHA-256 = <hex>", "md5: <hex>".
    const pre = s.match(/^([a-z][a-z0-9_-]{1,9})\s*[:=]\s*(.*)$/i);
    if(pre){ declared = named(pre[1]); if(!declared) return null; s = pre[2].trim(); }
  }
  // sha256sum / md5sum: "<hex>  name" or "<hex> *name" → the first token.
  s = s.split(/\s+/)[0] || '';
  s = s.toLowerCase();
  if(!/^[0-9a-f]+$/.test(s)) return null;
  const algo = BY_LEN[s.length];
  if(!algo) return null;
  if(declared && declared !== algo) return null;
  return { algo, hex: s };
}

function md5Init(){
  return {
    h: new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]),
    // The sine table and the per-round shifts travel with the state, so the
    // file declares nothing else at the top level.
    k: (() => {
      const k = new Uint32Array(64);
      for(let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
      return k;
    })(),
    r: new Uint8Array([7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
                       5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
                       4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
                       6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21]),
    m: new Uint32Array(16),
    buf: new Uint8Array(64),
    bufLen: 0,
    len: 0,
    // Compress the 64-byte block at p[off..off+63] into h (little-endian words).
    block(p, off){
      const m = this.m, k = this.k, r = this.r, h = this.h;
      for(let i = 0; i < 16; i++, off += 4)
        m[i] = p[off] | (p[off + 1] << 8) | (p[off + 2] << 16) | (p[off + 3] << 24);
      let a = h[0], b = h[1], c = h[2], d = h[3];
      for(let i = 0; i < 64; i++){
        let f, g;
        if(i < 16){ f = (b & c) | (~b & d); g = i; }
        else if(i < 32){ f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
        else if(i < 48){ f = b ^ c ^ d; g = (3 * i + 5) & 15; }
        else { f = c ^ (b | ~d); g = (7 * i) & 15; }
        const t = d;
        d = c; c = b;
        const x = (a + f + k[i] + m[g]) | 0;
        b = (b + ((x << r[i]) | (x >>> (32 - r[i])))) | 0;
        a = t;
      }
      h[0] += a; h[1] += b; h[2] += c; h[3] += d;
    },
  };
}

function md5Update(st, data){
  const n = data.length;
  let i = 0;
  st.len += n;
  if(st.bufLen){
    const take = Math.min(64 - st.bufLen, n);
    st.buf.set(data.subarray(0, take), st.bufLen);
    st.bufLen += take; i = take;
    if(st.bufLen < 64) return st;
    st.block(st.buf, 0); st.bufLen = 0;
  }
  for(; i + 64 <= n; i += 64) st.block(data, i);
  if(i < n){ st.buf.set(data.subarray(i), 0); st.bufLen = n - i; }
  return st;
}

function md5Digest(st){
  // Padding: 0x80, zeros to 56 mod 64, then the length in bits, little-endian.
  const bits = st.len * 8;
  const pad = new Uint8Array(((st.bufLen < 56) ? 56 : 120) - st.bufLen + 8);
  pad[0] = 0x80;
  const e = pad.length - 8;
  const lo = bits >>> 0, hi = Math.floor(bits / 0x100000000) >>> 0;
  pad[e] = lo; pad[e + 1] = lo >>> 8; pad[e + 2] = lo >>> 16; pad[e + 3] = lo >>> 24;
  pad[e + 4] = hi; pad[e + 5] = hi >>> 8; pad[e + 6] = hi >>> 16; pad[e + 7] = hi >>> 24;
  const len = st.len;
  md5Update(st, pad);
  st.len = len;
  let hex = '';
  for(let i = 0; i < 4; i++){
    const w = st.h[i];
    for(let j = 0; j < 4; j++) hex += ((w >>> (8 * j)) & 0xff).toString(16).padStart(2, '0');
  }
  return hex;
}
