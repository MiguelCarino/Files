// js/lib/ocrpdf.js: OCR word boxes → invisible-text ops for a searchable PDF.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, need } from './load.mjs';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('empty or invalid input gives no ops', need('wordsToPdfOps'), () => {
  assert.deepEqual(lib.wordsToPdfOps([], 100, 100, 100, 100), []);
  assert.deepEqual(lib.wordsToPdfOps(null, 100, 100, 100, 100), []);
  assert.deepEqual(lib.wordsToPdfOps([{ text: 'a', bbox: { x0: 0, y0: 0, x1: 5, y1: 5 } }], 0, 100, 100, 100), []);
  // No text, whitespace only, no box, a box of no area: skipped.
  assert.deepEqual(lib.wordsToPdfOps([
    { text: '', bbox: { x0: 0, y0: 0, x1: 5, y1: 5 } },
    { text: '   ', bbox: { x0: 0, y0: 0, x1: 5, y1: 5 } },
    { text: 'x' },
    { text: 'y', bbox: { x0: 5, y0: 5, x1: 5, y1: 9 } },
  ], 100, 100, 100, 100), []);
});

test('1:1 mapping flips y around the page height', need('wordsToPdfOps'), () => {
  const [op] = lib.wordsToPdfOps([{ text: 'Hello', bbox: { x0: 10, y0: 20, x1: 60, y1: 32 } }], 200, 100, 200, 100);
  assert.equal(op.text, 'Hello');
  assert.equal(op.x, 10);
  assert.equal(op.y, 100 - 32);   // the box bottom, measured from the page bottom
  assert.equal(op.size, 12);      // the box height
  assert.equal(op.hScale, 100);   // no measure function
});

test('scaling: a 300 DPI render over a page in points', need('wordsToPdfOps'), () => {
  // A US Letter page (612 × 792 pt) rendered at 300 DPI is 2550 × 3300 px.
  const k = 72 / 300;
  const [op] = lib.wordsToPdfOps([{ text: 'Total', bbox: { x0: 300, y0: 600, x1: 500, y1: 650 } }], 2550, 3300, 612, 792);
  assert.ok(near(op.x, 300 * k));
  assert.ok(near(op.y, 792 - 650 * k));
  assert.ok(near(op.size, 50 * k));
});

test('hScale stretches the word to the box width', need('wordsToPdfOps'), () => {
  // A font whose natural width is 0.5 × size per character.
  const measure = (t, size) => t.length * size * 0.5;
  const [op] = lib.wordsToPdfOps([{ text: 'abcd', bbox: { x0: 0, y0: 0, x1: 40, y1: 10 } }], 100, 100, 100, 100, measure);
  // natural = 4 × 10 × 0.5 = 20 pt, box = 40 pt → 200 %.
  assert.ok(near(op.hScale, 200));
  // A measure that returns 0 leaves the scale at 100.
  const [z] = lib.wordsToPdfOps([{ text: 'abcd', bbox: { x0: 0, y0: 0, x1: 40, y1: 10 } }], 100, 100, 100, 100, () => 0);
  assert.equal(z.hScale, 100);
});

test('characters Helvetica cannot encode become ? in the text layer', need('ocrPdfSafeText', 'wordsToPdfOps'), () => {
  assert.equal(lib.ocrPdfSafeText('Año ação €5 — “ok”'), 'Año ação €5 — “ok”');
  assert.equal(lib.ocrPdfSafeText('日本 ok'), '?? ok');
  assert.equal(lib.ocrPdfSafeText('a\tb\u0001c'), 'abc');
  const [op] = lib.wordsToPdfOps([{ text: 'Привет', bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }], 10, 10, 10, 10);
  assert.equal(op.text, '??????');
});

test('ocrWordsOf flattens Tesseract blocks, or takes data.words', need('ocrWordsOf'), () => {
  const w1 = { text: 'a', bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } };
  const w2 = { text: 'b', bbox: { x0: 2, y0: 0, x1: 3, y1: 1 } };
  const data = { blocks: [{ paragraphs: [{ lines: [{ words: [w1] }, { words: [w2] }] }] }] };
  assert.deepEqual(lib.ocrWordsOf(data), [w1, w2]);
  assert.deepEqual(lib.ocrWordsOf({ words: [w2] }), [w2]);
  assert.deepEqual(lib.ocrWordsOf(null), []);
  assert.deepEqual(lib.ocrWordsOf({ blocks: null }), []);
});

test('page sizes: 1 px = 1 pt for an image, clamped to 14400 pt; render pixels at a DPI', need('ocrImagePageSize', 'ocrRenderPx'), () => {
  assert.deepEqual(lib.ocrImagePageSize(800, 600), { w: 800, h: 600 });
  const big = lib.ocrImagePageSize(28800, 7200);
  assert.ok(near(big.w, 14400) && near(big.h, 3600));
  assert.deepEqual(lib.ocrRenderPx(612, 792, 300), { w: 2550, h: 3300 });
  assert.deepEqual(lib.ocrRenderPx(612, 792, 72), { w: 612, h: 792 });
});
