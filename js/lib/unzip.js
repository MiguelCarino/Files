'use strict';
/* ─── ZIP reader (replaces JSZip) ───
   zipEntries(bytes) → [{ name, method, compSize, size, offset, dataOffset,
     crc, isDir, utf8, encrypted }]
     Finds the end of central directory (scanning back over a comment of up
     to 64 KiB), follows the Zip64 locator when there is one, walks the
     central directory (Zip64 sizes and offsets from the 0x0001 extra field,
     Info-ZIP Unicode names from 0x7075) and checks each local header.
     offset is the local header; dataOffset is where the entry's data starts.
   zipRead(bytes, entry, opts?) → Promise<Uint8Array>
     Method 0 (stored) is returned as a view into bytes; method 8 (deflate)
     is inflated with DecompressionStream('deflate-raw'). Anything else
     throws. The CRC-32 (js/lib/zip.js crc32) is checked unless
     opts.verify === false.
   The archive may be hostile: every offset is bounded by the buffer, the
   entry count is capped at UNZIP_MAX_ENTRIES and one read inflates at most
   UNZIP_MAX_BYTES (or opts.max), stopping as soon as the output passes
   the size the directory declared. */
const UNZIP_MAX_ENTRIES = 65536 * 4;
const UNZIP_MAX_BYTES = 512 * 1048576;
// CP437, bytes 0x80–0xFF: the names a ZIP without the UTF-8 flag uses.
const _UNZIP_CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function _unzipName(b, utf8){
  let ascii = true;
  for(let i = 0; i < b.length; i++) if(b[i] > 0x7f){ ascii = false; break; }
  if(ascii || utf8) return new TextDecoder('utf-8').decode(b);
  // No flag: many tools still write UTF-8; only bytes that are not valid
  // UTF-8 are read as CP437.
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch(_){}
  let s = '';
  for(let i = 0; i < b.length; i++) s += b[i] < 0x80 ? String.fromCharCode(b[i]) : _UNZIP_CP437[b[i] - 0x80];
  return s;
}

function zipEntries(input){
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const len = b.length;
  const u16 = (p) => v.getUint16(p, true);
  const u32 = (p) => v.getUint32(p, true);
  const u64 = (p) => {
    const hi = u32(p + 4);
    if(hi > 0x1fffff) throw new Error('ZIP: 64-bit value out of range');
    return hi * 4294967296 + u32(p);
  };
  if(len < 22) throw new Error('ZIP: too short to be an archive');
  // End of central directory: 22 bytes plus a comment of up to 65535.
  let eocd = -1;
  for(let p = len - 22, stop = Math.max(0, len - 22 - 65535); p >= stop; p--){
    if(b[p] === 0x50 && b[p + 1] === 0x4b && b[p + 2] === 5 && b[p + 3] === 6 && p + 22 + u16(p + 20) <= len){ eocd = p; break; }
  }
  if(eocd < 0) throw new Error('ZIP: no end of central directory (not a ZIP, or truncated)');
  let total = u16(eocd + 10), cdSize = u32(eocd + 12), cdOff = u32(eocd + 16);
  let cdEnd = eocd;
  // Zip64: a locator just before the EOCD points at the Zip64 EOCD record.
  if(eocd >= 20 && u32(eocd - 20) === 0x07064b50){
    const z = u64(eocd - 12);
    if(z + 56 > eocd - 20 || u32(z) !== 0x06064b50) throw new Error('ZIP: bad Zip64 end of central directory');
    total = u64(z + 32); cdSize = u64(z + 40); cdOff = u64(z + 48);
    cdEnd = z;
  }
  if(total > UNZIP_MAX_ENTRIES) throw new Error('ZIP: too many entries (' + total + ')');
  if(cdOff + cdSize > cdEnd) throw new Error('ZIP: central directory runs past its end');
  // Data in front of the archive (a self-extractor stub) shifts every
  // offset by the same amount; the directory's real start tells by how much.
  let shift = 0;
  if(total && u32(cdOff) !== 0x02014b50){
    shift = cdEnd - (cdOff + cdSize);
    if(shift <= 0 || u32(cdOff + shift) !== 0x02014b50) throw new Error('ZIP: central directory not found');
  }
  const out = [];
  let p = cdOff + shift;
  const stop = cdOff + shift + cdSize;
  for(let i = 0; i < total; i++){
    if(p + 46 > stop || u32(p) !== 0x02014b50) throw new Error('ZIP: bad central directory entry ' + i);
    const flags = u16(p + 8), method = u16(p + 10);
    let crc = u32(p + 16), compSize = u32(p + 20), size = u32(p + 24);
    const nLen = u16(p + 28), xLen = u16(p + 30), cLen = u16(p + 32);
    let offset = u32(p + 42);
    const next = p + 46 + nLen + xLen + cLen;
    if(next > stop) throw new Error('ZIP: central directory entry ' + i + ' runs past the directory');
    const utf8 = !!(flags & 0x0800);
    let name = _unzipName(b.subarray(p + 46, p + 46 + nLen), utf8);
    // Extra fields: Zip64 sizes (only those stored as 0xFFFFFFFF, in order)
    // and the Info-ZIP Unicode path.
    for(let x = p + 46 + nLen, xEnd = x + xLen; x + 4 <= xEnd;){
      const id = u16(x), sz = u16(x + 2), d = x + 4;
      if(d + sz > xEnd) break;
      if(id === 0x0001){
        let q = d;
        if(size === 0xffffffff && q + 8 <= d + sz){ size = u64(q); q += 8; }
        if(compSize === 0xffffffff && q + 8 <= d + sz){ compSize = u64(q); q += 8; }
        if(offset === 0xffffffff && q + 8 <= d + sz){ offset = u64(q); q += 8; }
      } else if(id === 0x7075 && sz > 5 && b[d] === 1 && typeof crc32 === 'function'
        && crc32(b.subarray(p + 46, p + 46 + nLen)) === u32(d + 1)){
        name = new TextDecoder('utf-8').decode(b.subarray(d + 5, d + sz));
      }
      x = d + sz;
    }
    const lh = offset + shift;
    if(lh + 30 > len || u32(lh) !== 0x04034b50) throw new Error('ZIP: bad local header for ' + name);
    const dataOffset = lh + 30 + u16(lh + 26) + u16(lh + 28);
    if(dataOffset + compSize > len) throw new Error('ZIP: data for ' + name + ' runs past the end of the file');
    out.push({ name, method, compSize, size, offset: lh, dataOffset, crc, isDir: /\/$/.test(name), utf8, encrypted: !!(flags & 1) });
    p = next;
  }
  return out;
}

async function zipRead(input, entry, opts){
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const o = opts || {};
  const max = Math.min(o.max || UNZIP_MAX_BYTES, UNZIP_MAX_BYTES);
  if(entry.encrypted) throw new Error('ZIP: ' + entry.name + ' is encrypted');
  if(entry.size > max) throw new Error('ZIP: ' + entry.name + ' is too large to unpack here');
  if(entry.dataOffset + entry.compSize > b.length) throw new Error('ZIP: data for ' + entry.name + ' runs past the end of the file');
  const data = b.subarray(entry.dataOffset, entry.dataOffset + entry.compSize);
  let out;
  if(entry.method === 0){
    if(entry.compSize !== entry.size) throw new Error('ZIP: stored entry ' + entry.name + ' has mismatched sizes');
    out = data;
  } else if(entry.method === 8){
    if(typeof DecompressionStream !== 'function') throw new Error('ZIP: this browser cannot inflate (no DecompressionStream)');
    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const parts = [];
    let got = 0;
    try {
      for(;;){
        const { done, value } = await reader.read();
        if(done) break;
        got += value.length;
        if(got > entry.size || got > max){
          reader.cancel().catch(() => {});
          throw new Error('ZIP: ' + entry.name + ' inflates past its declared size');
        }
        parts.push(value);
      }
    } catch(e){
      if(/^ZIP:/.test(e && e.message)) throw e;
      throw new Error('ZIP: ' + entry.name + ' is not valid deflate data');
    }
    out = new Uint8Array(got);
    let at = 0;
    for(const x of parts){ out.set(x, at); at += x.length; }
    if(got !== entry.size) throw new Error('ZIP: ' + entry.name + ' inflated to ' + got + ' bytes, not ' + entry.size);
  } else {
    throw new Error('ZIP: ' + entry.name + ' uses compression method ' + entry.method + ', which is not supported here');
  }
  if(o.verify !== false && typeof crc32 === 'function' && crc32(out) !== entry.crc)
    throw new Error('ZIP: CRC mismatch in ' + entry.name);
  return out;
}
