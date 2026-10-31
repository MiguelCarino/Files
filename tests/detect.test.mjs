// js/lib/detect.js: bytes decide first, the name only after every signature
// has failed, the browser's mime last.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, need } from './load.mjs';
import { enc, cat, pad, rand, ftyp, PNG_HEAD, DICM, PE } from './fixtures.mjs';

const det = (bytes, name = 'x', mime = '') => lib.detectFormat(bytes, name, mime);
// Every key in want must match; notId: the id must NOT be this.
function is(bytes, name, want, mime = '') {
  const d = det(bytes, name, mime);
  for (const [k, v] of Object.entries(want)) {
    if (k === 'notId') assert.notEqual(d.id, v, `${name}: should not be ${v}`);
    else assert.equal(d[k], v, `${name}: ${k} = ${d[k]} (${JSON.stringify({ id: d.id, route: d.route, label: d.label })})`);
  }
  return d;
}

test('medical: DICM after the preamble, and a PNG named .dcm stays a PNG', need('detectFormat'), () => {
  const d = is(DICM(), 'scan', { id: 'dicom', route: 'dicom', kind: 'medical' });
  assert.equal(d.advisory.link, 'https://dcm.carino.systems/');
  assert.match(d.advisory.key, /dcm\.carino\.systems/);
  is(PNG_HEAD(), 'scan.dcm', { id: 'png', route: 'image' });
  is(rand(64), 'x.dcm', { id: 'dicom' });   // no preamble: the name decides
});

test('images', need('detectFormat'), () => {
  is(cat([0xFF, 0xD8, 0xFF, 0xE0], pad(8)), 'x.jpg', { id: 'jpeg', route: 'image', editable: true });
  is(PNG_HEAD(), 'x', { id: 'png', editable: false });
  is(cat('GIF89a', pad(8)), 'x', { id: 'gif', route: 'image' });
  is(cat('BM', pad(12), [40, 0, 0, 0], pad(8)), 'x', { id: 'bmp', route: 'image' });
  is(enc('BMW owners club notes...........'), 'x', { notId: 'bmp' });
  is(cat('RIFF', [0, 0, 0, 0], 'WEBPVP8 '), 'x', { id: 'webp', route: 'image' });
  is(cat('II*', [0], pad(8)), 'x.tif', { id: 'tiff', route: 'unknown' });
});

test('ISO-BMFF brands', need('detectFormat'), () => {
  for (const b of ['heic', 'heis', 'mif1']) is(ftyp(b), 'a', { id: 'heic', route: 'heic' });
  is(ftyp('avif'), 'a', { id: 'avif', kind: 'image', route: 'image' });
  is(ftyp('M4A '), 'a', { id: 'm4a', kind: 'audio', route: 'audio' });
  is(ftyp('isom'), 'a', { id: 'mp4', kind: 'video', route: 'video', detail: 'isom' });
});

test('PDF', need('detectFormat'), () => {
  is(enc('%PDF-1.7\n'), 'x', { id: 'pdf', route: 'pdf', editable: true });
});

test('audio and video', need('detectFormat'), () => {
  is(cat('ID3', [4, 0, 0, 0, 0, 0, 0]), 'x', { id: 'mp3', route: 'audio', editable: true });
  is(cat([0xFF, 0xFB, 0x90, 0x64], pad(8)), 'x', { id: 'mp3' });
  is(cat('fLaC', pad(8)), 'x', { id: 'flac', route: 'audio' });
  is(cat('OggS', pad(8)), 'x', { id: 'ogg', route: 'audio' });
  is(cat('RIFF', [0, 0, 0, 0], 'WAVEfmt '), 'x', { id: 'wav', route: 'audio' });
  is(cat('RIFF', [0, 0, 0, 0], 'AVI LIST'), 'x', { id: 'avi', route: 'video' });
  is(cat([0x1A, 0x45, 0xDF, 0xA3], pad(8)), 'x', { id: 'mkv', route: 'video' });
  is(rand(64), 'song.mp3', { id: 'mp3' });   // name only
});

test('SVG behind a BOM, whitespace or an XML prolog', need('detectFormat'), () => {
  is(cat([0xEF, 0xBB, 0xBF], ' \n\t <svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'x', { id: 'svg', kind: 'image', route: 'image' });
  is(enc('<?xml version="1.0"?>\n<!-- c -->\n<svg viewBox="0 0 1 1"/>'), 'x', { id: 'svg' });
  is(enc('<?xml version="1.0"?><root/>'), 'x', { notId: 'svg' });
});

test('fonts and archives', need('detectFormat'), () => {
  is(cat('OTTO', pad(8)), 'x', { id: 'font', label: 'OpenType font (CFF)' });
  is(cat('wOFF', pad(8)), 'x', { id: 'font', label: 'WOFF web font' });
  is(cat('PK', [3, 4], pad(8)), 'a.zip', { id: 'zip', label: 'ZIP archive' });
  is(cat('PK', [3, 4], pad(8)), 'a.docx', { id: 'zip', label: 'Word document' });
  is(cat([0x1F, 0x8B, 8, 0], pad(8)), 'x', { id: 'gz' });
  is(cat([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C], pad(8)), 'x', { id: '7z' });
  is(cat('Rar!', [0x1A, 0x07, 0], pad(8)), 'x', { id: 'rar' });
  is(cat(pad(257), 'ustar', pad(8)), 'x', { id: 'tar' });
});

test('executables', need('detectFormat'), () => {
  const d = is(PE(), 'x.exe', { id: 'pe' });
  assert.equal(d.advisory.level, 'warn');
  is(cat('MZ', rand(126)), 'x.exe', { notId: 'pe' });
  is(cat([0x7F], 'ELF', pad(12)), 'x', { id: 'elf' });
  is(cat([0xCA, 0xFE, 0xBA, 0xBE], pad(8)), 'x', { id: 'class' });
  is(cat([0xCF, 0xFA, 0xED, 0xFE], pad(8)), 'x', { id: 'macho' });
  is(cat([0, 0x61, 0x73, 0x6D, 1, 0, 0, 0]), 'x', { id: 'wasm' });
});

test('keys, certificates and databases', need('detectFormat'), () => {
  const k = is(enc('-----BEGIN PRIVATE KEY-----\nMIIE\n'), 'x', { id: 'key' });
  assert.equal(k.advisory.level, 'danger');
  is(enc('-----BEGIN CERTIFICATE-----\nMIIE\n'), 'x', { id: 'cert' });
  is(cat('SQLite format 3\0', pad(16)), 'x', { id: 'sqlite' });
  is(cat([0x03, 0xD9, 0xA2, 0x9A, 0x67, 0xFB, 0x4B, 0xB5]), 'x', { id: 'kdbx' });
  is(rand(64), 'notes.txt', { id: 'text' });
});

test('mime fallback, then unknown', need('detectFormat'), () => {
  is(rand(64), 'x.foo', { route: 'audio', id: 'other-audio' }, 'audio/x-foo');
  const d = is(rand(64), 'x', { id: 'bin', route: 'unknown' });
  assert.equal(d.advisory.level, 'info');
  is(undefined, 'x', { id: 'bin' });
});

test('extMismatch: a name that lies', need('detectFormat', 'extMismatch'), () => {
  assert.equal(lib.extMismatch(det(PNG_HEAD(), 'x.jpg'), 'x.jpg'), 'jpg');
  assert.equal(lib.extMismatch(det(PNG_HEAD(), 'x.png'), 'x.png'), null);
  assert.equal(lib.extMismatch(det(rand(64), 'x.foo', 'image/x-foo'), 'x.foo'), null);
});
