// js/lib/fieldnames.js: which custom field names each metadata writer can
// store, so the add-field row refuses up front instead of dropping one (B-4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, need } from './load.mjs';

const N = need('canStore', 'writableFields');

test('PDF: any name; a standard one keeps its spelling, others are custom properties', N, () => {
  assert.deepEqual(lib.canStore('pdf', 'ProjectCode'), { ok: true, name: 'ProjectCode', reason: null, note: 'Saved as a custom PDF property' });
  assert.deepEqual(lib.canStore('pdf', ' author '), { ok: true, name: 'Author', reason: null, note: null });
  assert.equal(lib.canStore('pdf', 'Número de caso').ok, true);
});

test('JPEG: the writable EXIF text tags only, matched without case', N, () => {
  assert.deepEqual(lib.canStore('jpeg', 'artist'), { ok: true, name: 'Artist', reason: null, note: null });
  assert.equal(lib.canStore('jpeg', 'LensModel').ok, true);
  const r = lib.canStore('jpeg', 'Foo');
  assert.equal(r.ok, false);
  assert.equal(r.name, 'Foo');
  assert.equal(r.reason, "JPEG can't store “{name}”. Use one of the suggested names.");
});

test('MP3: friendly names, their frame ids, and the other writable frames', N, () => {
  assert.equal(lib.canStore('mp3', 'Title').name, 'title');
  assert.equal(lib.canStore('mp3', 'tit2').name, 'title');            // the frame behind a row is that row
  assert.deepEqual(lib.canStore('mp3', 'tpe2'), { ok: true, name: 'TPE2', reason: null, note: null });
  const r = lib.canStore('mp3', 'APIC');
  assert.equal(r.ok, false);
  assert.equal(r.reason, "MP3 can't store “{name}”. Use one of the suggested names.");
});

test('an empty name is not ok and has nothing to explain yet', N, () => {
  for (const f of ['pdf', 'jpeg', 'mp3']) assert.deepEqual(lib.canStore(f, '   '), { ok: false, name: '', reason: null, note: null });
});

test('a format with no writer stores nothing', N, () => {
  assert.equal(lib.canStore('png', 'Author').ok, false);
  assert.deepEqual(lib.writableFields('png'), []);
});

test('the suggestions are exactly the names canStore accepts', N, () => {
  for (const f of ['pdf', 'jpeg', 'mp3']) {
    const names = lib.writableFields(f);
    assert.ok(names.length >= 6, f);
    for (const n of names) assert.equal(lib.canStore(f, n).name, n, f + ' ' + n);
  }
  assert.ok(lib.writableFields('jpeg').includes('DateTimeOriginal'));
  assert.ok(!lib.writableFields('mp3').includes('TIT2'), 'frame ids behind a friendly row are not suggested twice');
});

test('every ID3 frame named is one the writer can type', need('ID3_TEXT_FRAMES'), () => {
  for (const [id, kind] of Object.entries(lib.ID3_TEXT_FRAMES)) {
    assert.match(id, /^T[A-Z0-9]{3}$/);
    assert.ok(['list', 'int', 'text'].includes(kind), id);
  }
});
