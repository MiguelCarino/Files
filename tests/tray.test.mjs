// js/lib/tray.js: the batch tray's kind badges, set summary and set export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, need } from './load.mjs';

const f = (name, size, lastModified = 1) => ({ name, size, lastModified });

test('kindBadge: the code and colour #auto-ico shows; … until detected', need('kindBadge'), () => {
  assert.deepEqual(lib.kindBadge({ kind: 'pdf' }), { code: 'PDF', cat: 'purple' });
  assert.deepEqual(lib.kindBadge({ kind: 'heic' }), { code: 'HEIC', cat: 'pink' });
  assert.deepEqual(lib.kindBadge({ kind: 'unknown' }), { code: 'BIN', cat: 'grey' });
  assert.deepEqual(lib.kindBadge(null), { code: '…', cat: 'grey' });
});

test('setSummary: count, total size, mix in a fixed order', need('setSummary'), () => {
  const s = lib.setSummary([
    { file: f('a.png', 100), info: { kind: 'image' } },
    { file: f('b.pdf', 200), info: { kind: 'pdf' } },
    { file: f('c.jpg', 300), info: { kind: 'image' } },
    { file: f('d.bin', 50), info: null },
    { file: f('e.pdf', 1), info: { kind: 'pdf' } },
  ]);
  assert.equal(s.n, 5);
  assert.equal(s.size, 651);
  assert.deepEqual(s.mix, ['2 PDF', '2 IMG', '1 …']);
  assert.deepEqual(lib.setSummary([]), { n: 0, size: 0, mix: [] });
});

test('flattenMeta drops the File rows the export has as columns', need('flattenMeta'), () => {
  const flat = lib.flattenMeta([
    { name: 'File', rows: [{ k: 'Name', v: 'a.jpg' }, { k: 'Size', v: '1 KB' }, { k: 'Extension', v: 'jpg' },
      { k: 'SHA-256', v: '', key: '__sha' }, { k: 'MIME (guess)', v: 'image/jpeg' }] },
    { name: 'EXIF', rows: [{ k: 'Make', v: 'Canon' }, { k: 'ISO', v: 100 }] },
  ]);
  assert.deepEqual(flat, [
    { group: 'File', key: 'Extension', value: 'jpg' },
    { group: 'EXIF', key: 'Make', value: 'Canon' },
    { group: 'EXIF', key: 'ISO', value: '100' },
  ]);
});

test('unionColumns: first-seen order, no repeats', need('unionColumns'), () => {
  const cols = lib.unionColumns([
    { meta: [{ group: 'EXIF', key: 'Make', value: 'x' }, { group: 'EXIF', key: 'ISO', value: '1' }] },
    { meta: [{ group: 'PDF', key: 'Title', value: 't' }, { group: 'EXIF', key: 'Make', value: 'y' }] },
    { meta: [] },
  ]);
  assert.deepEqual(cols, ['EXIF: Make', 'EXIF: ISO', 'PDF: Title']);
});

test('rowsToCsv: header, one row per file, blanks for missing keys, formulas defused', need('rowsToCsv'), () => {
  const csv = lib.rowsToCsv([
    { file: 'a.jpg', type: 'JPEG image', size: 10, mime: 'image/jpeg', meta: [{ group: 'EXIF', key: 'Make', value: 'Canon' }] },
    { file: 'b.pdf', type: 'PDF document', size: 20, mime: 'application/pdf', meta: [
      { group: 'PDF', key: 'Title', value: '=HYPERLINK("x")' },
      { group: 'Parser', key: 'Note', value: 'one' }, { group: 'Parser', key: 'Note', value: 'two' }] },
  ]);
  const lines = csv.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '"file","type","size","MIME","EXIF: Make","PDF: Title","Parser: Note"');
  assert.equal(lines[1], '"a.jpg","JPEG image","10","image/jpeg","Canon","",""');
  assert.equal(lines[2], '"b.pdf","PDF document","20","application/pdf","","\'=HYPERLINK(""x"")","one; two"');
  assert.equal(lib.rowsToCsv([]), '"file","type","size","MIME"');
});

test('rowsToJson: one object per file, grouped metadata', need('rowsToJson'), () => {
  const out = lib.rowsToJson([
    { file: 'a.jpg', type: 'JPEG image', size: 10, mime: 'image/jpeg', meta: [
      { group: 'EXIF', key: 'Make', value: 'Canon' }, { group: 'EXIF', key: 'Make', value: 'Nikon' }] },
    { file: 'b.bin', type: 'Unknown', size: 2, mime: '', meta: [] },
  ]);
  assert.deepEqual(out, [
    { file: 'a.jpg', type: 'JPEG image', size: 10, metadata: { EXIF: { Make: 'Canon; Nikon' } } },
    { file: 'b.bin', type: 'Unknown', size: 2, metadata: {} },
  ]);
});

test('sameFile: same name, size and date', need('sameFile'), () => {
  const a = f('a.png', 10, 5);
  assert.equal(lib.sameFile(a, a), true);
  assert.equal(lib.sameFile(a, f('a.png', 10, 5)), true);
  assert.equal(lib.sameFile(a, f('a.png', 11, 5)), false);
  assert.equal(lib.sameFile(a, f('b.png', 10, 5)), false);
  assert.equal(lib.sameFile(a, null), false);
});
