// js/lib/eraser.js: Signature eraser strokes live in image coordinates, so a
// reprocess that crops differently puts them back in the same place (B-1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, need } from './load.mjs';

const N = need('eraserPoint', 'eraserRadius', 'eraserReplay');
// A 400×200 canvas shown at half size, 10 px from the viewport's corner.
const rect = { left: 10, top: 20, width: 200, height: 100 };

test('a pointer on the shown canvas maps to image pixels, crop included', N, () => {
  assert.deepEqual(lib.eraserPoint(10, 20, rect, 400, 200, { x: 0, y: 0 }), { x: 0, y: 0 });
  assert.deepEqual(lib.eraserPoint(110, 70, rect, 400, 200, { x: 0, y: 0 }), { x: 200, y: 100 });
  assert.deepEqual(lib.eraserPoint(110, 70, rect, 400, 200, { x: 30, y: 5 }), { x: 230, y: 105 });
  assert.deepEqual(lib.eraserPoint(110, 70, rect, 400, 200), { x: 200, y: 100 }, 'no crop = no offset');
});

test('the brush radius scales with the canvas, not the screen', N, () => {
  assert.equal(lib.eraserRadius(20, rect, 400), 40);
  assert.equal(lib.eraserRadius(20, { width: 0 }, 400), 20, 'a hidden canvas falls back to 1:1');
});

test('replay subtracts the new crop: same image spot after a re-crop', N, () => {
  const stroke = { r: 6, pts: [{ x: 230, y: 105 }, { x: 240, y: 110 }] };
  assert.deepEqual(lib.eraserReplay(stroke, { x: 30, y: 5 }), [{ x: 200, y: 100 }, { x: 210, y: 105 }]);
  // A bigger pad crops less: the canvas points move, the image points do not.
  assert.deepEqual(lib.eraserReplay(stroke, { x: 10, y: 0 }), [{ x: 220, y: 105 }, { x: 230, y: 110 }]);
});

test('display → image → canvas round-trips under any crop', N, () => {
  for (const crop of [{ x: 0, y: 0 }, { x: 17, y: 3 }, { x: 120, y: 64 }]) {
    const p = lib.eraserPoint(60, 45, rect, 400, 200, crop);
    const [c] = lib.eraserReplay({ pts: [p] }, crop);
    assert.deepEqual(c, { x: 100, y: 50 });
  }
});
