'use strict';
/* ─── metadata scrubbers ───
   DOM-free, so node tests can load it. Each takes the whole file as a
   Uint8Array and returns { bytes, removed: [label, …] }: the cleaned copy and
   what was taken out, as English labels (SCRUB_LABELS) that the page
   translates when it shows them. Nothing is decoded or re-encoded: the
   pixels, the audio frames and every byte the walker does not drop are
   copied exactly as they were.

   jpegStrip(bytes, { keep: 'none' | 'orientation' })
     Drops APP1 Exif, APP1 XMP (standard and extended), APP13 Photoshop/IPTC
     and COM. Keeps APP0 JFIF, APP2 ICC, APP14 Adobe and every other segment.
     Stops at SOS and copies the scan verbatim up to the EOI that ends the
     primary image. Anything after that EOI is dropped: MPF secondary images
     (Ultra HDR gain maps, previews), motion-photo MP4s and vendor trailers,
     each of which can carry its own EXIF and GPS. The APP2 MPF index, which
     points into that trailer, goes with it.
     keep 'orientation': a phone photo is often stored sideways with an EXIF
     Orientation saying how to turn it, so dropping the EXIF would show it
     sideways. When the dropped EXIF had an Orientation other than 1, a new
     minimal APP1 Exif is written in its place holding that one tag and
     nothing else (one IFD0 entry, no camera, dates or GPS).
   jpegRemoveXmpGps(bytes)
     Removes the location properties (xmpDropGps) from the standard XMP
     packet and rewrites that segment's length, and drops the data after the
     primary image's EOI (and the MPF index) as jpegStrip does, since an
     embedded image or motion video can hold its own position. Extended XMP
     is not touched (its chunks carry a digest and offsets; jpegStrip drops
     it whole).
   xmpDropGps(xml) / xmpHasGps(xml)
     Location properties in XMP: any prefix with a GPS… / Gps… local name
     (exif:GPSLatitude, drone-dji:GpsLatitude, Iptc4xmpExt:GPSLatitude…),
     drone-dji Absolute/RelativeAltitude, Iptc4xmpExt LocationCreated /
     LocationShown, photoshop City/State/Country and Iptc4xmpCore
     Location/CountryCode, as attributes or elements.
   xmpGpsLeft(bytes)  true when any XMP packet in the bytes still has one.
   pngStrip(bytes)    drops tEXt, iTXt, zTXt, eXIf and tIME; chunks are copied
                      whole, so their CRCs stay valid. Stops at IEND: bytes
                      after it are dropped.
   webpStrip(bytes)   drops the EXIF and XMP chunks, clears their VP8X flag
                      bits and rewrites the RIFF size.
   mp3Strip(bytes)    drops the ID3v2 tag(s) at the start (with footer), an
                      appended ID3v2 tag (3DI footer), a trailing 128-byte
                      ID3v1 'TAG', an APEv2 tag (APETAGEX footer) and a
                      Lyrics3 v2 tag (LYRICS200), in any order at the end.
                      Re-adding title / artist / album is the page's job
                      (browser-id3-writer).
   ════════════════════════════════════════════════════════════════ */
const SCRUB_LABELS = {
  exif: 'EXIF (camera, dates, GPS)',
  xmp: 'XMP',
  xmpGps: 'Location in XMP',
  iptc: 'IPTC',
  comment: 'Comment',
  pngText: 'PNG text',
  time: 'Timestamp',
  id3: 'ID3 tags',
  ape: 'APE tags',
  lyrics3: 'Lyrics3 tags',
  trailer: 'Data after the image (extra images, motion video)',
};

const _scrubAscii = (b, at, s) => {
  if(at + s.length > b.length) return false;
  for(let i = 0; i < s.length; i++) if(b[at + i] !== s.charCodeAt(i)) return false;
  return true;
};
const _scrubConcat = (parts) => {
  let n = 0;
  parts.forEach(p => { n += p.length; });
  const out = new Uint8Array(n);
  let o = 0;
  parts.forEach(p => { out.set(p, o); o += p.length; });
  return out;
};
const _scrubAdd = (list, label) => { if(list.indexOf(label) < 0) list.push(label); };

/* Every JPEG segment before the scan: { m (marker byte), start, end (exclusive),
   data (payload offset) }, plus `rest`, the offset of SOS (or of whatever
   could not be parsed), from which everything is copied verbatim. */
function _jpegSegments(b){
  if(b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) throw new Error('Not a JPEG file');
  const segs = [];
  let p = 2;
  while(p + 4 <= b.length){
    if(b[p] !== 0xFF) break;
    let q = p;
    while(q < b.length && b[q] === 0xFF) q++;   // fill bytes
    if(q >= b.length) break;
    const m = b[q];
    if(m === 0xDA || m === 0xD9) break;          // SOS / EOI: the rest is copied verbatim
    if(m === 0x01 || (m >= 0xD0 && m <= 0xD7)){ segs.push({ m, start: p, end: q + 1, data: q + 1 }); p = q + 1; continue; }
    if(q + 3 > b.length) break;
    const len = (b[q + 1] << 8) | b[q + 2];
    const end = q + 1 + len;
    if(len < 2 || end > b.length) break;
    segs.push({ m, start: p, end, data: q + 3 });
    p = end;
  }
  return { segs, rest: p };
}
/* The offset just past the EOI that ends the primary image, walking from
   `rest` (its first SOS): entropy-coded data is skipped (FF00 stuffing, RSTn
   and fill bytes), and the marker segments between progressive scans
   (DHT, DQT, DRI, SOS…) are stepped over by their length. A file with no
   EOI ends where it ends. */
function _jpegPrimaryEnd(b, rest){
  let p = rest;
  while(p < b.length){
    p = b.indexOf(0xFF, p);
    if(p < 0) return b.length;
    let q = p + 1;
    while(q < b.length && b[q] === 0xFF) q++;   // fill bytes
    if(q >= b.length) return b.length;
    const m = b[q];
    if(m === 0xD9) return q + 1;                  // EOI
    if(m === 0x00 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)){ p = q + 1; continue; }
    if(q + 3 > b.length) return b.length;
    const len = (b[q + 1] << 8) | b[q + 2];
    if(len < 2) { p = q + 1; continue; }
    p = q + 1 + len;
  }
  return b.length;
}
/* jpegExifSpan(head) → { start, end } | null: where the APP1 Exif segment
   sits (start at its FF marker, end exclusive), found by walking the marker
   segments of `head`, the start of a JPEG. end may lie past head.length
   when the segment is cut off by the head: the caller then reads exactly
   up to end (an APP1 is at most 64 KiB). null: not a JPEG, no Exif before
   the scan, or a segment before it that already runs past the head. */
function jpegExifSpan(b){
  if(!b || b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null;
  let p = 2;
  while(p + 4 <= b.length){
    if(b[p] !== 0xFF) return null;
    let q = p;
    while(q < b.length && b[q] === 0xFF) q++;
    if(q + 3 > b.length) return null;
    const m = b[q];
    if(m === 0xDA || m === 0xD9) return null;
    if(m === 0x01 || (m >= 0xD0 && m <= 0xD7)){ p = q + 1; continue; }
    const len = (b[q + 1] << 8) | b[q + 2];
    if(len < 2) return null;
    const end = q + 1 + len;
    if(m === 0xE1 && len >= 8 && q + 9 <= b.length && _scrubAscii(b, q + 3, 'Exif\0\0')) return { start: p, end };
    if(end > b.length) return null;
    p = end;
  }
  return null;
}
const _isMpf = (b, s) => s.m === 0xE2 && _scrubAscii(b, s.data, 'MPF\0');
const _XMP_NS = 'http://ns.adobe.com/xap/1.0/\0';
const _XMP_EXT_NS = 'http://ns.adobe.com/xmp/extension/\0';

/* EXIF Orientation (1-8) from an APP1 Exif payload, or 0. */
function _exifOrientation(b, s, e){
  if(!_scrubAscii(b, s, 'Exif\0\0')) return 0;
  const t = s + 6;
  if(t + 8 > e) return 0;
  const le = b[t] === 0x49;
  const u16 = (o) => le ? (b[o] | (b[o + 1] << 8)) : ((b[o] << 8) | b[o + 1]);
  const u32 = (o) => le ? ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216)
                        : (b[o] * 16777216 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]));
  const ifd = t + u32(t + 4);
  if(ifd + 2 > e) return 0;
  const n = u16(ifd);
  for(let i = 0; i < n; i++){
    const en = ifd + 2 + i * 12;
    if(en + 12 > e) return 0;
    if(u16(en) === 0x0112 && u16(en + 2) === 3){
      const v = u16(en + 8);
      return v >= 1 && v <= 8 ? v : 0;
    }
  }
  return 0;
}
/* A whole APP1 Exif segment holding only IFD0 Orientation (big-endian TIFF). */
function _orientationApp1(v){
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0,            // "Exif\0\0"
    0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08,        // MM, 42, IFD0 at 8
    0x00, 0x01,                                            // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, v, 0x00, 0x00,   // Orientation SHORT 1 = v
    0x00, 0x00, 0x00, 0x00];                               // no next IFD
  const len = payload.length + 2;
  return Uint8Array.from([0xFF, 0xE1, len >> 8, len & 0xFF].concat(payload));
}

function jpegStrip(bytes, opts){
  const keep = (opts && opts.keep) || 'none';
  const b = bytes;
  const { segs, rest } = _jpegSegments(b);
  const parts = [b.subarray(0, 2)], removed = [];
  let orientation = 0, orientationPlaced = false;
  for(const s of segs){
    let drop = null;
    if(s.m === 0xE1 && _scrubAscii(b, s.data, 'Exif\0')){
      drop = SCRUB_LABELS.exif;
      if(!orientation) orientation = _exifOrientation(b, s.data, s.end);
    }
    else if(s.m === 0xE1 && (_scrubAscii(b, s.data, _XMP_NS) || _scrubAscii(b, s.data, _XMP_EXT_NS))) drop = SCRUB_LABELS.xmp;
    else if(s.m === 0xED) drop = SCRUB_LABELS.iptc;
    else if(s.m === 0xFE) drop = SCRUB_LABELS.comment;
    else if(_isMpf(b, s)) drop = SCRUB_LABELS.trailer;
    if(drop){
      _scrubAdd(removed, drop);
      // The orientation-only EXIF takes the dropped EXIF's place.
      if(drop === SCRUB_LABELS.exif && keep === 'orientation' && orientation > 1 && !orientationPlaced){
        parts.push(_orientationApp1(orientation));
        orientationPlaced = true;
      }
      continue;
    }
    parts.push(b.subarray(s.start, s.end));
  }
  const end = _jpegPrimaryEnd(b, rest);
  parts.push(b.subarray(rest, end));
  if(end < b.length) _scrubAdd(removed, SCRUB_LABELS.trailer);
  return { bytes: removed.length ? _scrubConcat(parts) : b, removed, orientation: orientationPlaced ? orientation : 0 };
}

/* Location property names in XMP (see the header). */
const _XMP_LOC = '(?:[\\w.-]+:(?:GPS|Gps)\\w*|drone-dji:(?:Absolute|Relative)Altitude|Iptc4xmpExt:Location(?:Created|Shown)'
  + '|photoshop:(?:City|State|Country)|Iptc4xmpCore:(?:Location|CountryCode))';
const _XMP_LOC_SELF = new RegExp('<(' + _XMP_LOC + ')(?=[\\s/>])[^>]*\\/>', 'g');
const _XMP_LOC_PAIR = new RegExp('<(' + _XMP_LOC + ')(?=[\\s>])[^>]*>[\\s\\S]*?<\\/\\1\\s*>', 'g');
const _XMP_LOC_ATTR = new RegExp('\\s+' + _XMP_LOC + '\\s*=\\s*("[^"]*"|\'[^\']*\')', 'g');
/* The XMP text minus every location attribute and element. */
function xmpDropGps(xml){
  return xml.replace(_XMP_LOC_SELF, '').replace(_XMP_LOC_PAIR, '').replace(_XMP_LOC_ATTR, '');
}
function xmpHasGps(xml){ return xmpDropGps(xml) !== xml; }
/* Any XMP packet (<x:xmpmeta …</x:xmpmeta>) in the bytes that still names a
   location. Read as latin1, so it works on any container. */
function xmpGpsLeft(bytes){
  const CH = 0x8000;
  let text = '';
  for(let i = 0; i < bytes.length; i += CH) text += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  const re = /<x:xmpmeta[\s\S]*?<\/x:xmpmeta>/g;
  let m;
  while((m = re.exec(text))) if(xmpHasGps(m[0])) return true;
  return false;
}

function jpegRemoveXmpGps(bytes){
  const b = bytes;
  const { segs, rest } = _jpegSegments(b);
  const parts = [b.subarray(0, 2)], removed = [];
  for(const s of segs){
    if(s.m === 0xE1 && _scrubAscii(b, s.data, _XMP_NS)){
      const head = s.data + _XMP_NS.length;
      const xml = new TextDecoder('utf-8').decode(b.subarray(head, s.end));
      const clean = xmpDropGps(xml);
      if(clean !== xml){
        const body = new TextEncoder().encode(clean);
        const len = 2 + _XMP_NS.length + body.length;   // only ever shrinks, so it still fits
        parts.push(Uint8Array.from([0xFF, 0xE1, len >> 8, len & 0xFF]), b.subarray(s.data, head), body);
        _scrubAdd(removed, SCRUB_LABELS.xmpGps);
        continue;
      }
    }
    if(_isMpf(b, s)){ _scrubAdd(removed, SCRUB_LABELS.trailer); continue; }
    parts.push(b.subarray(s.start, s.end));
  }
  const end = _jpegPrimaryEnd(b, rest);
  parts.push(b.subarray(rest, end));
  if(end < b.length) _scrubAdd(removed, SCRUB_LABELS.trailer);
  return { bytes: removed.length ? _scrubConcat(parts) : b, removed };
}

function pngStrip(bytes){
  const b = bytes;
  const SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  if(b.length < 8 || SIG.some((x, i) => b[i] !== x)) throw new Error('Not a PNG file');
  const parts = [b.subarray(0, 8)], removed = [];
  let p = 8, sawEnd = false;
  while(p + 12 <= b.length){
    const len = ((b[p] << 24) >>> 0) + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]);
    const end = p + 12 + len;
    if(end > b.length) break;
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    let drop = null;
    if(type === 'eXIf') drop = SCRUB_LABELS.exif;
    else if(type === 'tIME') drop = SCRUB_LABELS.time;
    else if(type === 'iTXt' && _scrubAscii(b, p + 8, 'XML:com.adobe.xmp\0')) drop = SCRUB_LABELS.xmp;
    else if(type === 'tEXt' || type === 'iTXt' || type === 'zTXt') drop = SCRUB_LABELS.pngText;
    if(drop) _scrubAdd(removed, drop);
    else parts.push(b.subarray(p, end));
    p = end;
    if(type === 'IEND'){ sawEnd = true; break; }
  }
  if(p < b.length){
    // Past IEND: appended data (another file, a vendor trailer) goes.
    // Unparseable chunk data before IEND stays as it was.
    if(sawEnd) _scrubAdd(removed, SCRUB_LABELS.trailer);
    else parts.push(b.subarray(p));
  }
  return { bytes: removed.length ? _scrubConcat(parts) : b, removed };
}

function webpStrip(bytes){
  const b = bytes;
  if(!_scrubAscii(b, 0, 'RIFF') || !_scrubAscii(b, 8, 'WEBP')) throw new Error('Not a WebP file');
  const riffEnd = Math.min(b.length, 8 + (b[4] | (b[5] << 8) | (b[6] << 16)) + b[7] * 16777216);
  const parts = [], removed = [];
  let p = 12, vp8x = -1, outLen = 12;
  while(p + 8 <= riffEnd){
    const fourcc = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
    const size = (b[p + 4] | (b[p + 5] << 8) | (b[p + 6] << 16)) + b[p + 7] * 16777216;
    const end = Math.min(riffEnd, p + 8 + size + (size & 1));
    if(fourcc === 'EXIF') _scrubAdd(removed, SCRUB_LABELS.exif);
    else if(fourcc === 'XMP ') _scrubAdd(removed, SCRUB_LABELS.xmp);
    else {
      if(fourcc === 'VP8X') vp8x = outLen;
      parts.push(b.subarray(p, end));
      outLen += end - p;
    }
    p = end;
  }
  if(!removed.length) return { bytes: b, removed };
  const out = _scrubConcat([b.subarray(0, 12)].concat(parts));
  const size = out.length - 8;
  out[4] = size & 0xFF; out[5] = (size >> 8) & 0xFF; out[6] = (size >> 16) & 0xFF; out[7] = (size >>> 24) & 0xFF;
  if(vp8x >= 0) out[vp8x + 8] &= ~(0x08 | 0x04);   // VP8X flags: EXIF (bit 3) and XMP (bit 2) off
  return { bytes: out, removed };
}

function mp3Strip(bytes){
  const b = bytes;
  const removed = [];
  const syncsafe = (o) => ((b[o] & 0x7F) << 21) | ((b[o + 1] & 0x7F) << 14) | ((b[o + 2] & 0x7F) << 7) | (b[o + 3] & 0x7F);
  let start = 0, end = b.length;
  // ID3v2 at the start; a file can carry more than one in a row.
  while(start + 10 <= end && _scrubAscii(b, start, 'ID3') && b[start + 3] < 0xFF && b[start + 4] < 0xFF){
    const total = 10 + syncsafe(start + 6) + ((b[start + 5] & 0x10) ? 10 : 0);
    if(start + total > end) break;
    start += total;
    _scrubAdd(removed, SCRUB_LABELS.id3);
  }
  const u32le = (o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216;
  // Tags at the end, peeled off one at a time until none is left: ID3v1,
  // appended ID3v2, APEv2 and Lyrics3 v2 come in various orders.
  for(let guard = 0; guard < 8; guard++){
    // ID3v1 at the very end.
    if(end - start >= 128 && _scrubAscii(b, end - 128, 'TAG')){ end -= 128; _scrubAdd(removed, SCRUB_LABELS.id3); continue; }
    // An appended ID3v2 tag, found by its footer.
    if(end - start >= 20 && _scrubAscii(b, end - 10, '3DI')){
      const total = 20 + syncsafe(end - 4);
      if(end - total >= start && _scrubAscii(b, end - total, 'ID3')){ end -= total; _scrubAdd(removed, SCRUB_LABELS.id3); continue; }
    }
    // APEv2: a 32-byte footer 'APETAGEX'; size (LE u32 at +12) covers the
    // items and the footer; flags bit 31 (at +20) says a 32-byte header leads.
    if(end - start >= 32 && _scrubAscii(b, end - 32, 'APETAGEX')){
      const f = end - 32;
      const total = u32le(f + 12) + ((b[f + 23] & 0x80) ? 32 : 0);
      if(total >= 32 && end - total >= start){ end -= total; _scrubAdd(removed, SCRUB_LABELS.ape); continue; }
    }
    // Lyrics3 v2: 'LYRICSBEGIN' … 6-digit size + 'LYRICS200'.
    if(end - start >= 15 + 11 && _scrubAscii(b, end - 9, 'LYRICS200')){
      let n = 0, ok = true;
      for(let i = end - 15; i < end - 9; i++){ const d = b[i] - 48; if(d < 0 || d > 9){ ok = false; break; } n = n * 10 + d; }
      const total = n + 15;
      if(ok && end - total >= start && _scrubAscii(b, end - total, 'LYRICSBEGIN')){ end -= total; _scrubAdd(removed, SCRUB_LABELS.lyrics3); continue; }
    }
    // Lyrics3 v1: 'LYRICSBEGIN' … 'LYRICSEND' (at most 5100 bytes of lyrics).
    if(end - start >= 20 && _scrubAscii(b, end - 9, 'LYRICSEND')){
      const from = Math.max(start, end - 9 - 5100 - 11);
      let at = -1;
      for(let i = end - 9 - 11; i >= from; i--) if(_scrubAscii(b, i, 'LYRICSBEGIN')){ at = i; break; }
      if(at >= 0){ end = at; _scrubAdd(removed, SCRUB_LABELS.lyrics3); continue; }
    }
    break;
  }
  return { bytes: removed.length ? b.slice(start, end) : b, removed };
}

/* ─── PDF clean copy: a full rewrite (spec §13, B-6) ───
   pdfRewriteClean(PDFLib, bytes) → { bytes, counts, notes }
     Loads the PDF, takes out of the source pages what says who, when and with
     what, then copies every page into a brand-new document
     (pdfCopyPagesSeeded, js/lib/pageops.js), so nothing the pages do not
     reach can come along: not the trailer /Info, not the catalog XMP, not the
     objects left behind by incremental saves (old revisions). Per page:
     /Metadata, /PieceInfo and /LastModified go; per annotation: /T (author;
     kept on form widgets, where it is the field's name), /M, /CreationDate,
     /RC (the rich-text copy of the comment, which carries its own styling
     and sometimes the author) and its own /Metadata. The comment text
     (/Contents) stays: it is content. A form keeps working: the catalog's
     /AcroForm is copied with the same copier, so its fields and the pages'
     widgets stay one set of objects. The new document has no Info, no
     catalog /Metadata and no /ID, and is saved without object streams.
     Bookmarks, named destinations and the tag structure live in the catalog
     and are not carried; a note says so when the source had them.
     Throws an Error with .code 'encrypted' for an encrypted PDF.

     counts.unused (Old revisions): indirect objects the parser found that
     are not reachable from the source trailer (/Root, /Info, /Encrypt):
     objects earlier saves left behind (a deleted page, a replaced image, an
     old XMP packet under a new number). An object rewritten under the same
     number is not counted: pdf-lib keeps only its last version. It is
     counted on the source by reachability, not as source minus output
     objects, which would also count every metadata object removed below
     and the new page tree. None of these objects reach the copy. The
     linearization dict and hint stream of a Fast Web View file are not
     counted: they are layout data, not revisions.

     Objects the pages reach (XObjects, patterns, shadings, fonts, the form)
     lose /Metadata, /PieceInfo and /LastModified too, and a JPEG image
     stream (only filter DCTDecode) goes through jpegStrip, so a placed photo
     loses its EXIF (GPS, camera, dates), XMP, IPTC and comments; APP14
     Adobe and ICC stay. counts.objMeta counts the objects changed.

   pdfScrubReport(counts) → [{ key, vars }]: the report lines, in this order,
     only those that apply: Document info ({n} fields) · Document XMP ·
     Page-level XMP ({n} pages) · PieceInfo ({n} pages) · Application private
     data (the catalog's own /PieceInfo) · Annotation authors ({n}) ·
     Annotation dates ({n}) (dates, rich text or XMP removed from comments
     and widgets) · Embedded object metadata ({n}) (XMP, PieceInfo or
     LastModified on objects the pages use, and EXIF/XMP inside JPEG image
     streams) · Old revisions ({n} unused objects).
   scrubTruncate(list, max, open) → { shown, more }: the first max items and
     how many are folded behind "+{k} more"; open shows them all. */
function pdfScrubReport(counts){
  const c = counts || {}, out = [];
  const n = (v) => Math.max(0, v | 0);
  if(n(c.info)) out.push({ key: 'Document info ({n} fields)', vars: { n: n(c.info) } });
  if(c.xmp) out.push({ key: 'Document XMP', vars: null });
  if(n(c.pageXmp)) out.push({ key: 'Page-level XMP ({n} pages)', vars: { n: n(c.pageXmp) } });
  if(n(c.pieceInfo)) out.push({ key: 'PieceInfo ({n} pages)', vars: { n: n(c.pieceInfo) } });
  if(c.appData) out.push({ key: 'Application private data', vars: null });
  if(n(c.annotAuthors)) out.push({ key: 'Annotation authors ({n})', vars: { n: n(c.annotAuthors) } });
  if(n(c.annotDates)) out.push({ key: 'Annotation dates ({n})', vars: { n: n(c.annotDates) } });
  if(n(c.objMeta)) out.push({ key: 'Embedded object metadata ({n})', vars: { n: n(c.objMeta) } });
  if(n(c.unused)) out.push({ key: 'Old revisions ({n} unused objects)', vars: { n: n(c.unused) } });
  return out;
}
const SCRUB_REPORT_MAX = 6;
function scrubTruncate(list, max, open){
  list = list || [];
  max = max == null ? SCRUB_REPORT_MAX : Math.max(0, max | 0);
  if(open || list.length <= max) return { shown: list.slice(), more: 0 };
  return { shown: list.slice(0, max), more: list.length - max };
}

async function pdfRewriteClean(PDFLib, bytes){
  const { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray, PDFRawStream } = PDFLib;
  const AF_KEY = PDFName.of('AcroForm');
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if(src.isEncrypted){ const e = new Error('encrypted'); e.code = 'encrypted'; throw e; }
  const ctx = src.context;
  const look = (o) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  const counts = { info: 0, xmp: false, pageXmp: 0, pieceInfo: 0, appData: false, annotAuthors: 0, annotDates: 0, objMeta: 0, unused: 0 };
  const notes = [];

  // Old revisions: everything parsed minus what the trailer reaches.
  const seen = new Set();
  const stack = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt];
  while(stack.length){
    let o = stack.pop();
    if(!o) continue;
    if(o instanceof PDFRef){
      const k = o.toString();
      if(seen.has(k)) continue;
      seen.add(k);
      o = ctx.lookup(o);
      if(!o) continue;
    }
    if(o instanceof PDFDict) o.entries().forEach(([, v]) => stack.push(v));
    else if(o instanceof PDFArray) o.asArray().forEach(v => stack.push(v));
    else if(o && o.dict instanceof PDFDict) o.dict.entries().forEach(([, v]) => stack.push(v));
  }
  const all = ctx.enumerateIndirectObjects();
  // A linearized ("Fast Web View") file carries a parameter dict and a hint
  // stream that the trailer never reaches; they are not old revisions.
  const LIN = PDFName.of('Linearized'), SK = PDFName.of('S'), TYK = PDFName.of('Type');
  const unreached = all.filter(([ref]) => !seen.has(ref.toString()));
  const linear = unreached.some(([, o]) => o instanceof PDFDict && o.get(LIN));
  counts.unused = unreached.filter(([, o]) => {
    if(o instanceof PDFDict && o.get(LIN)) return false;
    if(linear && o && !(o instanceof PDFDict) && o.dict instanceof PDFDict && o.dict.get(SK) && !o.dict.get(TYK)) return false;
    return true;
  }).length;

  const info = look(ctx.trailerInfo.Info);
  if(info instanceof PDFDict) counts.info = info.entries().length;
  const cat = src.catalog;
  const MK = PDFName.of('Metadata'), PK = PDFName.of('PieceInfo'), LK = PDFName.of('LastModified');
  if(cat.get(MK)) counts.xmp = true;
  if(cat.get(PK) || cat.get(LK)) counts.appData = true;
  if(['Outlines', 'Names', 'StructTreeRoot', 'Dests'].some(k => cat.get(PDFName.of(k))))
    notes.push('Bookmarks and the document outline are not carried into the rewritten copy.');

  const ANN = ['M', 'CreationDate', 'RC'].map(k => PDFName.of(k));
  const TK = PDFName.of('T'), WIDGET = PDFName.of('Widget'), SUB = PDFName.of('Subtype');
  let kept = false;
  const pages = src.getPages();
  for(const page of pages){
    const node = page.node;
    if(node.get(MK)){ node.delete(MK); counts.pageXmp++; }
    let piece = false;
    if(node.get(PK)){ node.delete(PK); piece = true; }
    if(node.get(LK)){ node.delete(LK); piece = true; }
    if(piece) counts.pieceInfo++;
    const annots = look(node.get(PDFName.of('Annots')));
    const list = annots instanceof PDFArray ? annots.asArray() : [];
    for(const a of list){
      const ad = look(a);
      if(!(ad instanceof PDFDict)) continue;
      let dated = false;
      if(ad.get(TK) && look(ad.get(SUB)) !== WIDGET){ ad.delete(TK); counts.annotAuthors++; }
      ANN.forEach(k => { if(ad.get(k)){ ad.delete(k); dated = true; } });
      if(ad.get(MK)){ ad.delete(MK); dated = true; }
      if(dated) counts.annotDates++;
      if(ad.get(PDFName.of('Contents'))) kept = true;
    }
  }

  // Everything the pages and the form reach (XObjects, patterns, fonts…):
  // an image or form XObject keeps its own XMP, PieceInfo and dates, and a
  // JPEG image stream (DCTDecode) is the photo file itself, EXIF and all.
  const DCT = PDFName.of('DCTDecode'), FK = PDFName.of('Filter'), PARENT = PDFName.of('Parent');
  const pageKeys = new Set(pages.map(p => p.ref.toString()));
  const reach = new Map(), walk = [];
  pages.forEach(p => p.node.entries().forEach(([k, v]) => { if(k !== PARENT) walk.push(v); }));
  walk.push(cat.get(AF_KEY));
  while(walk.length){
    let o = walk.pop();
    if(!o) continue;
    if(o instanceof PDFRef){
      const k = o.toString();
      if(reach.has(k) || pageKeys.has(k)) continue;
      const v = ctx.lookup(o);
      reach.set(k, o);
      o = v;
      if(!o) continue;
    }
    if(o instanceof PDFDict) o.entries().forEach(([k, v]) => { if(k !== PARENT) walk.push(v); });
    else if(o instanceof PDFArray) o.asArray().forEach(v => walk.push(v));
    else if(o && o.dict instanceof PDFDict) o.dict.entries().forEach(([, v]) => walk.push(v));
  }
  for(const ref of reach.values()){
    const o = ctx.lookup(ref);
    const d = o instanceof PDFDict ? o : (o && o.dict instanceof PDFDict ? o.dict : null);
    if(!d) continue;
    let hit = false;
    [MK, PK, LK].forEach(k => { if(d.get(k)){ d.delete(k); hit = true; } });
    if(d !== o && o instanceof PDFRawStream){
      const f = look(d.get(FK));
      const only = f === DCT || (f instanceof PDFArray && f.size() === 1 && look(f.get(0)) === DCT);
      if(only){
        try {
          const r = jpegStrip(o.getContents());
          if(r.removed.length){ ctx.assign(ref, PDFRawStream.of(d, r.bytes)); hit = true; }
        } catch(_){ /* not a JPEG we can walk: copied as it is */ }
      }
    }
    if(hit) counts.objMeta++;
  }

  const out = await PDFDocument.create({ updateMetadata: false });
  const { pages: copied, copier } = pdfCopyPagesSeeded(PDFLib, out, src, pages.map((_, i) => i));
  copied.forEach(p => out.addPage(p));
  const AF = PDFName.of('AcroForm');
  const acro = cat.get(AF);
  if(acro && look(acro)){
    out.catalog.set(AF, copier.copy(acro));
    kept = true;
  }
  if(kept) notes.push('Comment text and form field values were kept: remove them in a PDF editor if they should not be shared.');
  out.context.trailerInfo.Info = undefined;
  out.context.trailerInfo.ID = undefined;
  const outBytes = await out.save({ useObjectStreams: false, updateFieldAppearances: false });
  return { bytes: outBytes, counts, notes };
}
