// js/lib/csv.js: a metadata value never runs as a spreadsheet formula.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, need } from './load.mjs';

test('formula prefixes get an apostrophe', need('csvCell'), () => {
  for (const p of ['=', '+', '-', '@', '\t', '\r']) assert.equal(lib.csvCell(p + 'SUM(A1)'), `"'${p}SUM(A1)"`);
  assert.equal(lib.csvCell('a=b'), '"a=b"');
});

test('every cell quoted, inner quotes doubled', need('csvCell'), () => {
  assert.equal(lib.csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(lib.csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(lib.csvCell(null), '""');
  assert.equal(lib.csvCell(undefined), '""');
  assert.equal(lib.csvCell(42), '"42"');
});
