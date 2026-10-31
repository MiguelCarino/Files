'use strict';
/* ════════════════════════════════════════════════════════════════
   Incremental SHA-256 (FIPS 180-4), pure JS and DOM-free, so the same
   file runs on the page (the fallback when no worker can start) and in
   js/hash-worker.js (importScripts). Feed it any number of chunks of any
   size; only these three functions are declared:
     const st = sha256Init();
     sha256Update(st, uint8array);   // as many times as needed
     sha256Digest(st);               // → lowercase hex, 64 chars
   The state is a plain object; a digested state must not be updated again.
   ════════════════════════════════════════════════════════════════ */

function sha256Init(){
  return {
    h: new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]),
    // The round constants and the message schedule travel with the state, so
    // the file declares nothing else at the top level.
    k: new Uint32Array([
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]),
    w: new Uint32Array(64),
    buf: new Uint8Array(64),   // a partial block carried to the next update
    bufLen: 0,
    len: 0,                    // total bytes fed; exact up to 2^53
    // Compress the 64-byte block at p[off..off+63] into h.
    block(p, off){
      const w = this.w, k = this.k, h = this.h;
      for(let i = 0; i < 16; i++, off += 4)
        w[i] = (p[off] << 24) | (p[off + 1] << 16) | (p[off + 2] << 8) | p[off + 3];
      for(let i = 16; i < 64; i++){
        const a = w[i - 15], b = w[i - 2];
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
        const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let A = h[0], B = h[1], C = h[2], D = h[3], E = h[4], F = h[5], G = h[6], H = h[7];
      for(let i = 0; i < 64; i++){
        const S1 = ((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7));
        const ch = (E & F) ^ (~E & G);
        const t1 = (H + S1 + ch + k[i] + w[i]) | 0;
        const S0 = ((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10));
        const maj = (A & B) ^ (A & C) ^ (B & C);
        const t2 = (S0 + maj) | 0;
        H = G; G = F; F = E; E = (D + t1) | 0;
        D = C; C = B; B = A; A = (t1 + t2) | 0;
      }
      h[0] += A; h[1] += B; h[2] += C; h[3] += D;
      h[4] += E; h[5] += F; h[6] += G; h[7] += H;
    },
  };
}

function sha256Update(st, data){
  const n = data.length;
  let i = 0;
  st.len += n;
  // Top up a carried partial block first.
  if(st.bufLen){
    const take = Math.min(64 - st.bufLen, n);
    st.buf.set(data.subarray(0, take), st.bufLen);
    st.bufLen += take; i = take;
    if(st.bufLen < 64) return st;
    st.block(st.buf, 0); st.bufLen = 0;
  }
  // Whole blocks straight from the input, no copy.
  for(; i + 64 <= n; i += 64) st.block(data, i);
  if(i < n){ st.buf.set(data.subarray(i), 0); st.bufLen = n - i; }
  return st;
}

function sha256Digest(st){
  // Padding: 0x80, zeros to 56 mod 64, then the length in bits, big-endian.
  const bits = st.len * 8;
  const pad = new Uint8Array(((st.bufLen < 56) ? 56 : 120) - st.bufLen + 8);
  pad[0] = 0x80;
  const e = pad.length;
  const hi = Math.floor(bits / 0x100000000), lo = bits >>> 0;
  pad[e - 8] = hi >>> 24; pad[e - 7] = hi >>> 16; pad[e - 6] = hi >>> 8; pad[e - 5] = hi;
  pad[e - 4] = lo >>> 24; pad[e - 3] = lo >>> 16; pad[e - 2] = lo >>> 8; pad[e - 1] = lo;
  const len = st.len;
  sha256Update(st, pad);
  st.len = len;
  let hex = '';
  for(let i = 0; i < 8; i++) hex += (st.h[i] >>> 0).toString(16).padStart(8, '0');
  return hex;
}
