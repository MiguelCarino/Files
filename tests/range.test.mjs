// js/lib/range.js: "1, 3-5" page ranges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, need } from './load.mjs';

const r = (s, max) => Array.from(lib.parsePageRange(s, max));

test('lists and ranges, sorted and de-duplicated', need('parsePageRange'), () => {
  assert.deepEqual(r('1-3,5', 10), [1, 2, 3, 5]);
  assert.deepEqual(r(' 5 , 1-3 , 2 ', 10), [1, 2, 3, 5]);
});

test('empty means every page', need('parsePageRange'), () => {
  assert.deepEqual(r('', 4), [1, 2, 3, 4]);
  assert.deepEqual(r('   ', 2), [1, 2]);
});

test('an open range is skipped; a reversed one is read forwards', need('parsePageRange'), () => {
  assert.deepEqual(r('7-', 10), []);
  assert.deepEqual(r('3-1', 10), [1, 2, 3]);
});

test('out of range is clipped to 1..max', need('parsePageRange'), () => {
  assert.deepEqual(r('0, 4, 12', 5), [4]);
  assert.deepEqual(r('4-9', 5), [4, 5]);
  assert.deepEqual(r('0-2', 5), [1, 2]);
  assert.deepEqual(r('x, 2', 5), [2]);
});
