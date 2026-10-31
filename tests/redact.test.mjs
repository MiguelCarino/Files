// js/lib/redact.js: the Redact mode's geometry, word search and output re-check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, need } from './load.mjs';
import * as F from './fixtures.mjs';

const W = (text, x0, y0, x1, y1, line) => ({ text, bbox: { x0, y0, x1, y1 }, ...(line != null ? { line } : {}) });

test('normRect: a drag from any corner', need('normRect'), () => {
  assert.deepEqual(lib.normRect(10, 20, 60, 50), { x: 10, y: 20, w: 50, h: 30 });
  assert.deepEqual(lib.normRect(60, 50, 10, 20), { x: 10, y: 20, w: 50, h: 30 });
  assert.deepEqual(lib.normRect(60, 20, 10, 50), { x: 10, y: 20, w: 50, h: 30 });
  assert.deepEqual(lib.normRect(5, 5, 5, 5), { x: 5, y: 5, w: 0, h: 0 });
});

test('clampRect: cut to the image, nothing outside', need('clampRect'), () => {
  assert.deepEqual(lib.clampRect({ x: -10, y: -5, w: 30, h: 20 }, 100, 80), { x: 0, y: 0, w: 20, h: 15 });
  assert.deepEqual(lib.clampRect({ x: 90, y: 70, w: 30, h: 30 }, 100, 80), { x: 90, y: 70, w: 10, h: 10 });
  assert.deepEqual(lib.clampRect({ x: 10, y: 10, w: 5, h: 5 }, 100, 80), { x: 10, y: 10, w: 5, h: 5 });
  const out = lib.clampRect({ x: 200, y: 200, w: 5, h: 5 }, 100, 80);
  assert.equal(out.w, 0); assert.equal(out.h, 0);
});

test('toImageRect: displayed pixels → image pixels', need('toImageRect'), () => {
  // A 4000×3000 photo shown at 400×300.
  assert.deepEqual(lib.toImageRect({ x: 10, y: 10, w: 50, h: 30 }, 400, 300, 4000, 3000), { x: 100, y: 100, w: 500, h: 300 });
  // A 16×16 icon blown up to 320×320.
  assert.deepEqual(lib.toImageRect({ x: 20, y: 40, w: 160, h: 80 }, 320, 320, 16, 16), { x: 1, y: 2, w: 8, h: 4 });
  // No display size: unchanged.
  assert.deepEqual(lib.toImageRect({ x: 1, y: 2, w: 3, h: 4 }, 0, 0, 10, 10), { x: 1, y: 2, w: 3, h: 4 });
});

test('padRect: grown on every side, then clamped', need('padRect'), () => {
  assert.deepEqual(lib.padRect({ x: 10, y: 10, w: 20, h: 10 }, 2, 100, 100), { x: 8, y: 8, w: 24, h: 14 });
  assert.deepEqual(lib.padRect({ x: 1, y: 1, w: 20, h: 10 }, 2, 22, 100), { x: 0, y: 0, w: 22, h: 13 });
});

test('matchWords: case-, accent- and punctuation-blind, one word', need('matchWords'), () => {
  const words = [W('José', 0, 0, 40, 10, 0), W('Pérez,', 45, 0, 90, 10, 0), W('jose@mail.com', 0, 20, 120, 30, 1), W('other', 0, 40, 50, 50, 2)];
  assert.deepEqual(lib.matchWords(words, 'JOSE'), [{ x: 0, y: 0, w: 40, h: 10 }, { x: 0, y: 20, w: 120, h: 10 }]);
  assert.deepEqual(lib.matchWords(words, 'perez'), [{ x: 45, y: 0, w: 45, h: 10 }]);
  assert.deepEqual(lib.matchWords(words, 'nobody'), []);
  assert.deepEqual(lib.matchWords(words, '   '), []);
  assert.deepEqual(lib.matchWords(words, '…'), []);
  assert.deepEqual(lib.matchWords(null, 'x'), []);
});

test('matchWords: a phrase across consecutive words on one line, one merged box', need('matchWords'), () => {
  const words = [
    W('Name:', 0, 0, 50, 12, 0), W('John', 55, 0, 95, 12, 0), W('Smith,', 100, 2, 150, 14, 0),
    W('John', 0, 30, 40, 42, 1),
    W('Smith', 0, 50, 50, 62, 2),
  ];
  assert.deepEqual(lib.matchWords(words, 'john smith'), [{ x: 55, y: 0, w: 95, h: 14 }],
    'the line-break pair (lines 1 and 2) is not a phrase');
  assert.deepEqual(lib.matchWords(words, 'name john smith'), [{ x: 0, y: 0, w: 150, h: 14 }]);
  // Middle words must match whole.
  assert.deepEqual(lib.matchWords(words, 'name jo smith'), []);
});

test('matchWords: no line index → lines judged from the boxes', need('matchWords'), () => {
  const words = [W('Juan', 0, 0, 40, 10), W('García', 45, 1, 100, 11), W('Juan', 0, 30, 40, 40), W('Ruiz', 45, 30, 90, 40),
    W('García', 0, 60, 60, 70)];
  assert.deepEqual(lib.matchWords(words, 'juan garcia'), [{ x: 0, y: 0, w: 100, h: 11 }]);
});

test('redactWordsOf: flattens blocks with each word\'s line', need('redactWordsOf'), () => {
  const data = { blocks: [{ paragraphs: [{ lines: [
    { words: [{ text: 'a', bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }, { text: 'b', bbox: { x0: 2, y0: 0, x1: 3, y1: 1 } }] },
    { words: [{ text: 'c', bbox: { x0: 0, y0: 5, x1: 1, y1: 6 } }] },
  ] }] }] };
  assert.deepEqual(lib.redactWordsOf(data).map((w) => w.text + w.line), ['a0', 'b0', 'c1']);
  assert.deepEqual(lib.redactWordsOf({ words: [{ text: 'x', bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }] }).map((w) => w.text), ['x']);
  assert.deepEqual(lib.redactWordsOf(null), []);
});

test('redactOutType: JPEG, PNG and WebP stay; the rest become PNG', need('redactOutType'), () => {
  assert.deepEqual(lib.redactOutType('image/jpeg'), { mime: 'image/jpeg', ext: 'jpg', quality: 0.92 });
  assert.equal(lib.redactOutType('image/png').ext, 'png');
  assert.equal(lib.redactOutType('image/webp').ext, 'webp');
  for (const m of ['image/heic', 'image/avif', 'image/gif', 'image/bmp', 'image/svg+xml', '', undefined])
    assert.deepEqual(lib.redactOutType(m), { mime: 'image/png', ext: 'png', quality: undefined }, String(m));
});

test('redactClean: finds and drops EXIF / XMP left in an output', need('redactClean', 'SCRUB_LABELS'), () => {
  const dirty = lib.redactClean(F.jpeg(), 'image/jpeg');
  assert.ok(dirty.found.includes(lib.SCRUB_LABELS.exif) && dirty.found.includes(lib.SCRUB_LABELS.xmp));
  assert.ok(!F.has(dirty.bytes, 'Exif') && !F.has(dirty.bytes, 'xap/1.0'));
  const png = lib.redactClean(F.realPng(), 'image/png');
  assert.deepEqual(png.found, []);
  assert.ok(lib.redactClean(F.png(), 'image/png').found.length > 0);
  assert.deepEqual(lib.redactClean(Uint8Array.of(1, 2, 3), 'image/gif').found, []);
});
