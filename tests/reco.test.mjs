// js/lib/reco.js: which apps open each detected type.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, need } from './load.mjs';

const names = (id, file) => lib.recommendFor(id ? { id } : null, file).map((a) => a.name);

test('DICOM leads with the Carino DICOM editor', need('recommendFor'), () => {
  const r = lib.recommendFor({ id: 'dicom' }, 'a.dcm');
  assert.equal(r[0].url, 'https://dcm.carino.systems/');
  assert.equal(r[0].name, 'Carino DICOM Editor');
});

test('the extension wins for ZIP-family documents', need('recommendFor'), () => {
  assert.deepEqual(names('zip', 'report.docx'), ['LibreOffice']);
  assert.deepEqual(names('zip', 'book.epub'), ['Calibre']);
  assert.deepEqual(names('zip', 'a.zip'), ['7-Zip', 'PeaZip']);
});

test('unknown falls back to ExifTool, never empty', need('recommendFor'), () => {
  assert.deepEqual(names('nonesuch', 'x'), ['ExifTool']);
  assert.deepEqual(names(null, ''), ['ExifTool']);
});

test('no duplicates, every entry has a name and an https url', need('recommendFor'), () => {
  const ids = ['jpeg', 'png', 'pdf', 'mp3', 'mp4', 'mkv', 'zip', 'font', 'key', 'pe', 'dicom', 'bin', 'svg', 'avif', 'm4a', 'other-image'];
  for (const id of ids) for (const file of ['x', 'x.svg', 'x.docx']) {
    const r = lib.recommendFor({ id }, file);
    assert.ok(r.length > 0, id);
    assert.equal(new Set(r.map((a) => a.name)).size, r.length, id + ' ' + file + ': duplicate');
    for (const a of r) assert.match(a.url, /^https:\/\//, a.name);
  }
});
