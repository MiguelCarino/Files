// js/lib/scrub.js: byte-level metadata removal (the F2 fixtures).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, need } from './load.mjs';
import * as F from './fixtures.mjs';

const has = F.has;
const tail = (b, n) => Buffer.from(b.subarray(b.length - n));
const markers = (b) => lib._jpegSegments(b).segs.map((s) => s.m);
const L = () => lib.SCRUB_LABELS;

test('jpegStrip drops Exif, XMP and COM, keeps APP0 and the scan', need('jpegStrip', '_jpegSegments', 'SCRUB_LABELS'), () => {
  const src = F.jpeg();
  const r = lib.jpegStrip(src, { keep: 'none' });
  assert.deepEqual(markers(r.bytes), [0xE0]);
  assert.ok(!has(r.bytes, 'Exif') && !has(r.bytes, 'xap/1.0') && !has(r.bytes, 'secret'));
  assert.deepEqual(tail(r.bytes, 17), tail(src, 17), 'SOS + scan + EOI verbatim');
  assert.deepEqual(Buffer.from(r.bytes.subarray(0, 20)), Buffer.from(src.subarray(0, 20)), 'SOI + APP0 verbatim');
  assert.deepEqual(Array.from(r.removed), [L().exif, L().xmp, L().comment]);
  // Orientation 1: nothing worth keeping, no APP1 written.
  assert.deepEqual(markers(lib.jpegStrip(src, { keep: 'orientation' }).bytes), [0xE0]);
});

test('jpegStrip keeps a sideways photo upright, and ICC', need('jpegStrip', '_jpegSegments', '_exifOrientation'), () => {
  const r = lib.jpegStrip(F.jpegFull(), { keep: 'orientation' });
  assert.deepEqual(markers(r.bytes), [0xE0, 0xE1, 0xE2]);
  assert.ok(r.removed.includes(L().iptc));
  assert.equal(r.orientation, 6);
  const app1 = lib._jpegSegments(r.bytes).segs[1];
  assert.equal(lib._exifOrientation(r.bytes, app1.data, app1.end), 6);
  assert.ok(!has(r.bytes, 'Cam'), 'Make gone');
  assert.ok(has(r.bytes, 'ICC_PROFILE'), 'ICC kept');
  assert.deepEqual(markers(lib.jpegStrip(F.jpegFull(), { keep: 'none' }).bytes), [0xE0, 0xE2]);
});

test('jpegRemoveXmpGps removes exactly the GPS bits', need('jpegRemoveXmpGps', '_jpegSegments'), () => {
  const src = F.jpeg();
  const r = lib.jpegRemoveXmpGps(src);
  assert.deepEqual(Array.from(r.removed), [L().xmpGps]);
  const segs = lib._jpegSegments(r.bytes).segs;
  assert.deepEqual(segs.map((s) => s.m), [0xE0, 0xE1, 0xE1, 0xFE]);
  const x = segs[2];
  assert.equal((r.bytes[x.data - 2] << 8) | r.bytes[x.data - 1], x.end - x.data + 2, 'segment length rewritten');
  const xml = Buffer.from(r.bytes.subarray(x.data + 29, x.end)).toString('utf8');
  assert.equal(xml, F.xmpWithGps
    .replace(' exif:GPSLatitude="48,51.5N" exif:GPSLongitude="2,17.4E"', '')
    .replace('<exif:GPSAltitude>35/1</exif:GPSAltitude><exif:GPSVersionID/>', ''));
  assert.ok(has(r.bytes.subarray(segs[1].start, segs[1].end), 'Exif'), 'EXIF untouched');
  assert.deepEqual(tail(r.bytes, 17), tail(src, 17));
  const again = lib.jpegRemoveXmpGps(r.bytes);
  assert.equal(again.removed.length, 0);
  assert.equal(again.bytes, r.bytes, 'idempotent: same array back');
});

test('pngStrip drops tEXt and tIME, every kept CRC stays valid', need('pngStrip'), () => {
  const r = lib.pngStrip(F.png());
  assert.ok(!has(r.bytes, 'tEXt') && !has(r.bytes, 'tIME') && !has(r.bytes, 'Author'));
  assert.ok(has(r.bytes, 'IHDR') && has(r.bytes, 'IDAT'));
  assert.deepEqual(tail(r.bytes, 12), Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]));
  const buf = Buffer.from(r.bytes);
  let p = 8, chunks = 0;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    assert.equal(F.crc32ref(r.bytes.subarray(p + 4, p + 8 + len)), buf.readUInt32BE(p + 8 + len));
    p += 12 + len; chunks++;
  }
  assert.equal(chunks, 3);
  assert.equal(p, buf.length);
  assert.deepEqual(Array.from(r.removed), [L().pngText, L().time]);
});

test('webpStrip drops EXIF/XMP, clears their VP8X flags, rewrites the RIFF size', need('webpStrip'), () => {
  const r = lib.webpStrip(F.webp());
  const b = Buffer.from(r.bytes);
  assert.equal(b.readUInt32LE(4), b.length - 8);
  assert.ok(!has(r.bytes, 'EXIF') && !has(r.bytes, 'XMP ') && has(r.bytes, 'VP8L'));
  assert.equal(b.toString('latin1', 12, 16), 'VP8X');
  assert.equal(b[20], 0x10, 'only the alpha flag left');
  assert.deepEqual(Array.from(r.removed), [L().exif, L().xmp]);
});

test('mp3Strip drops leading and appended ID3v2 and ID3v1', need('mp3Strip'), () => {
  const audio = Buffer.from(F.audio());
  const r = lib.mp3Strip(F.mp3());
  assert.deepEqual(Buffer.from(r.bytes), audio);
  assert.deepEqual(Array.from(r.removed), [L().id3]);
  assert.deepEqual(Buffer.from(lib.mp3Strip(F.mp3Appended()).bytes), audio);
  const clean = F.audio();
  const c = lib.mp3Strip(clean);
  assert.equal(c.removed.length, 0);
  assert.equal(c.bytes, clean);
});

test('idempotent, and the wrong format throws', need('jpegStrip', 'pngStrip', 'webpStrip'), () => {
  const once = lib.jpegStrip(F.jpeg()).bytes;
  const twice = lib.jpegStrip(once);
  assert.equal(twice.removed.length, 0);
  assert.equal(twice.bytes, once);
  assert.equal(lib.pngStrip(lib.pngStrip(F.png()).bytes).removed.length, 0);
  assert.equal(lib.webpStrip(lib.webpStrip(F.webp()).bytes).removed.length, 0);
  assert.throws(() => lib.pngStrip(F.jpeg()));
  assert.throws(() => lib.jpegStrip(F.png()));
  assert.throws(() => lib.webpStrip(F.png()));
});

test('jpegStrip removes the GPS-bearing Exif of the smoke fixture', need('jpegStrip'), () => {
  const src = F.withExifGps(F.jpeg());
  const r = lib.jpegStrip(src);
  assert.ok(!has(r.bytes, 'Exif'));
  assert.ok(r.removed.includes(L().exif));
});

const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(n); let p = 0; a.forEach((x) => { o.set(x, p); p += x.length; }); return o; };

test('jpegStrip and jpegRemoveXmpGps drop data after the primary EOI (MPF / motion photo)', need('jpegStrip', 'jpegRemoveXmpGps', '_jpegPrimaryEnd'), () => {
  const primary = F.jpeg();
  const src = cat(primary, F.withExifGps(F.jpeg()));
  assert.equal(lib._jpegPrimaryEnd(src, lib._jpegSegments(src).rest), primary.length);
  const r = lib.jpegStrip(src, { keep: 'orientation' });
  assert.ok(!has(r.bytes, 'Exif'), 'appended EXIF gone');
  assert.ok(r.removed.includes(L().trailer));
  assert.deepEqual(tail(r.bytes, 17), tail(primary, 17), 'ends at the primary EOI');
  const g = lib.jpegRemoveXmpGps(src);
  assert.ok(g.removed.includes(L().trailer));
  assert.equal(g.bytes.length < src.length, true);
  assert.deepEqual(tail(g.bytes, 17), tail(primary, 17));
  // A plain JPEG reports no trailer.
  assert.ok(!lib.jpegStrip(primary).removed.includes(L().trailer));
});

test('pngStrip drops bytes after IEND', need('pngStrip'), () => {
  const src = cat(F.png(), Uint8Array.from(Buffer.from('Exif\0\0GPS trailer')));
  const r = lib.pngStrip(src);
  assert.ok(!has(r.bytes, 'trailer'));
  assert.ok(r.removed.includes(L().trailer));
});

test('xmpDropGps covers DJI, IPTC Extension and photoshop location', need('xmpDropGps', 'xmpHasGps', 'xmpGpsLeft'), () => {
  const xml = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description drone-dji:GpsLatitude="+22.5" drone-dji:GpsLongitude="+113.9"'
    + ' drone-dji:AbsoluteAltitude="+50" photoshop:City="Paris" dc:format="image/jpeg">'
    + '<Iptc4xmpExt:GPSLatitude>1</Iptc4xmpExt:GPSLatitude>'
    + '<Iptc4xmpExt:LocationCreated><rdf:Bag><rdf:li Iptc4xmpExt:City="Paris"/></rdf:Bag></Iptc4xmpExt:LocationCreated>'
    + '</rdf:Description></rdf:RDF></x:xmpmeta>';
  const out = lib.xmpDropGps(xml);
  assert.ok(!/22\.5|113\.9|Paris|\+50|GPSLatitude|LocationCreated/.test(out), out);
  assert.ok(out.includes('dc:format="image/jpeg"'), 'other properties kept');
  assert.equal(lib.xmpHasGps(xml), true);
  assert.equal(lib.xmpHasGps(out), false);
  assert.equal(lib.xmpGpsLeft(Uint8Array.from(Buffer.from('junk' + xml + 'junk', 'latin1'))), true);
  assert.equal(lib.xmpGpsLeft(Uint8Array.from(Buffer.from(out, 'latin1'))), false);
});

test('mp3Strip drops APEv2 and Lyrics3 tags', need('mp3Strip'), () => {
  const audio = F.audio();
  const item = cat(Uint8Array.from([5, 0, 0, 0, 0, 0, 0, 0]), Uint8Array.from(Buffer.from('Artist\0Alice', 'latin1')));
  const apeBlock = (flags) => { const b = Buffer.alloc(32); b.write('APETAGEX', 0, 'latin1'); b.writeUInt32LE(2000, 8); b.writeUInt32LE(item.length + 32, 12); b.writeUInt32LE(1, 16); b.writeUInt32LE(flags >>> 0, 20); return Uint8Array.from(b); };
  const ape = cat(apeBlock(0xA0000000), item, apeBlock(0x80000000));
  const r = lib.mp3Strip(cat(audio, ape));
  assert.deepEqual(Buffer.from(r.bytes), Buffer.from(audio));
  assert.deepEqual(Array.from(r.removed), [L().ape]);
  // APE before ID3v1, Lyrics3 v2 before that.
  const v1 = Buffer.alloc(128); v1.write('TAG', 0, 'latin1');
  const body = 'LYRICSBEGININD00003abc';
  const ly = Uint8Array.from(Buffer.from(body + String(body.length).padStart(6, '0') + 'LYRICS200', 'latin1'));
  const r2 = lib.mp3Strip(cat(audio, ly, ape, Uint8Array.from(v1)));
  assert.deepEqual(Buffer.from(r2.bytes), Buffer.from(audio));
  assert.deepEqual(Array.from(r2.removed), [L().id3, L().ape, L().lyrics3]);
});
