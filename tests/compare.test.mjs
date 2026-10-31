// js/lib/compare.js: the Compare mode's diff and its CSV.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, need } from './load.mjs';

const r = (group, key, value, extra) => Object.assign({ group, key, value }, extra || {});
const strip = (rows) => rows.map(({ key, group, a, b, same }) => ({ key, group, a, b, same }));

test('diffRows: same, different and missing rows', need('diffRows', 'countDiffs'), () => {
  const a = [r('File', 'Type', 'PNG image'), r('File', 'Size', '10'), r('EXIF', 'Make', 'Canon')];
  const b = [r('File', 'Type', 'PNG image'), r('File', 'Size', '12'), r('XMP', 'Creator', 'Ana')];
  const d = lib.diffRows(a, b);
  assert.deepEqual(strip(d), [
    { key: 'Type', group: 'File', a: 'PNG image', b: 'PNG image', same: true },
    { key: 'Size', group: 'File', a: '10', b: '12', same: false },
    { key: 'Make', group: 'EXIF', a: 'Canon', b: null, same: false },
    { key: 'Creator', group: 'XMP', a: null, b: 'Ana', same: false },
  ]);
  assert.equal(lib.countDiffs(d), 3);
});

test('diffRows: stable group order, B-only rows join their group after A’s', need('diffRows'), () => {
  const a = [r('File', 'Type', 'x'), r('PDF', 'Pages', '2'), r('File', 'Size', '1')];
  const b = [r('Office', 'App', 'Word'), r('File', 'Type', 'x'), r('File', 'MD5', 'm'), r('PDF', 'Pages', '2')];
  const d = lib.diffRows(a, b);
  assert.deepEqual(d.map((x) => x.group + ':' + x.key), ['File:Type', 'File:Size', 'File:MD5', 'PDF:Pages', 'Office:App']);
});

test('diffRows: a key repeated within a group is matched by occurrence', need('diffRows'), () => {
  const a = [r('Parser', 'Note', 'one'), r('Parser', 'Note', 'two')];
  const b = [r('Parser', 'Note', 'one'), r('Parser', 'Note', 'three'), r('Parser', 'Note', 'four')];
  const d = lib.diffRows(a, b);
  assert.deepEqual(d.map((x) => [x.a, x.b, x.same]), [['one', 'one', true], ['two', 'three', false], [null, 'four', false]]);
});

test('diffRows: keeps the input rows, values as strings, empty sides', need('diffRows', 'countDiffs'), () => {
  const ar = r('File', 'Size', 5, { tr: '{n} B' });
  const d = lib.diffRows([ar], [r('File', 'Size', '5')]);
  assert.equal(d[0].same, true);
  assert.equal(d[0].ar, ar);
  assert.deepEqual(lib.diffRows([], []), []);
  assert.deepEqual(lib.diffRows(null, undefined), []);
  assert.equal(lib.countDiffs(lib.diffRows([r('G', 'k', '')], [])), 1, 'an empty value is not a missing one');
  assert.deepEqual(strip(lib.diffRows([r('G', 'k', '')], [r('G', 'k', null)])), [{ key: 'k', group: 'G', a: '', b: '', same: true }]);
});

test('compareCsv: header, every cell quoted, formulas defused', need('diffRows', 'compareCsv'), () => {
  const d = lib.diffRows([r('File', 'Type', 'PNG'), r('EXIF', 'Artist', '=HYPERLINK("x")')], [r('File', 'Type', 'PNG')]);
  const lines = lib.compareCsv(d, { a: 'a.png', b: 'b.png' }).split('\n');
  assert.equal(lines[0], '"group","field","A: a.png","B: b.png","same"');
  assert.equal(lines[1], '"File","Type","PNG","PNG","yes"');
  assert.equal(lines[2], '"EXIF","Artist","\'=HYPERLINK(""x"")","","no"');
  assert.equal(lib.compareCsv([]).split('\n')[0], '"group","field","A","B","same"');
});
