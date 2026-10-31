// js/lib/scrub.js jpegExifSpan: where the APP1 Exif segment is, so the image
// converter's EXIF carry reads that span (from the head, or one slice up to
// its end) instead of the whole JPEG.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, need } from './load.mjs';
import { jpeg, jpegFull, exifGpsApp1, withExifGps, cat, pad } from './fixtures.mjs';

const app1At = (b) => {
  for (let i = 2; i < b.length - 10; i++)
    if (b[i] === 0xFF && b[i + 1] === 0xE1 && Buffer.from(b.subarray(i + 4, i + 10)).toString('latin1') === 'Exif\0\0') return i;
  return -1;
};

test('finds the Exif APP1 after APP0', need('jpegExifSpan'), () => {
  for (const b of [jpeg(), jpegFull()]) {
    const s = lib.jpegExifSpan(b);
    const at = app1At(b);
    assert.ok(at > 2);
    assert.equal(s.start, at);
    assert.equal(s.end, at + 2 + ((b[at + 2] << 8) | b[at + 3]));
    assert.equal(b[s.end], 0xFF, 'the next segment starts right after');
  }
});

test('right after SOI, and a span past a cut-off head', need('jpegExifSpan'), () => {
  const full = withExifGps(jpeg());
  const app1 = exifGpsApp1();
  assert.deepEqual(lib.jpegExifSpan(full), { start: 2, end: 2 + app1.length });
  // The head ends inside the segment: the span still says where it ends.
  const head = full.subarray(0, 40);
  assert.deepEqual(lib.jpegExifSpan(head), { start: 2, end: 2 + app1.length });
});

test('null: no Exif, not a JPEG, or an earlier segment past the head', need('jpegExifSpan'), () => {
  // SOI, APP0 (JFIF), then SOS: no Exif.
  const app0 = [0xFF, 0xE0, 0, 16, ...Buffer.from('JFIF\0', 'latin1'), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  assert.equal(lib.jpegExifSpan(Uint8Array.from([0xFF, 0xD8, ...app0, 0xFF, 0xDA, 0, 8, 1, 1, 0, 0, 0x3F, 0])), null);
  assert.equal(lib.jpegExifSpan(Uint8Array.from([0x89, 0x50, 0x4E, 0x47])), null);
  assert.equal(lib.jpegExifSpan(null), null);
  // A big APP2 (ICC) that the head cuts off, before any Exif.
  const big = cat([0xFF, 0xD8, 0xFF, 0xE2, 0xFF, 0x00], pad(100));
  assert.equal(lib.jpegExifSpan(big), null);
  // An XMP APP1 is not Exif.
  const xmp = cat([0xFF, 0xD8, 0xFF, 0xE1, 0, 12], 'http://ns.a', [0xFF, 0xDA]);
  assert.equal(lib.jpegExifSpan(xmp), null);
});
