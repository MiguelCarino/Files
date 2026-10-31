'use strict';
/* ─── store-only ZIP writer (replaces JSZip) ───
   Local file headers + central directory + EOCD, CRC-32, no compression. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for(let n = 0; n < 256; n++){
    let c = n;
    for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf){
  let c = 0xFFFFFFFF;
  for(let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
async function makeZip(entries){ // entries: [{name, blob}]
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
  const parts = [], centrals = [];
  let offset = 0;
  for(const e of entries){
    const data = new Uint8Array(await e.blob.arrayBuffer());
    const name = enc.encode(e.name);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);            // local file header signature
    lh.setUint16(4, 20, true);                    // version needed
    lh.setUint16(6, 0x0800, true);                // flags: UTF-8 names
    lh.setUint16(8, 0, true);                     // method: store
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);            // central directory signature
    ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true);          // extra/comment/disk/attrs stay 0
    ch.setUint32(42, offset, true);               // local header offset
    centrals.push([ch.buffer, name]);
    offset += 30 + name.length + data.length;
  }
  let cdSize = 0;
  for(const [h, n] of centrals){ parts.push(h, n); cdSize += 46 + n.length; }
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, centrals.length, true); eocd.setUint16(10, centrals.length, true);
  eocd.setUint32(12, cdSize, true); eocd.setUint32(16, offset, true);
  parts.push(eocd.buffer);
  return new Blob(parts, { type: 'application/zip' });
}
