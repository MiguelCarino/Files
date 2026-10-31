// js/lib/unzip.js: the native ZIP reader (end of central directory →
// central directory → local headers; stored and deflate entries).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, need } from './load.mjs';
import { zipOf, docxLike, rand } from './fixtures.mjs';

const inflates = typeof DecompressionStream === 'function' ? {} : { skip: 'no DecompressionStream in this Node' };
const both = (...n) => Object.assign({}, need(...n), inflates);
const text = (u8) => new TextDecoder().decode(u8);

test('reads what makeZip (stored) writes', need('makeZip', 'zipEntries', 'zipRead'), async () => {
  const r = rand(3000);
  const blob = await lib.makeZip([{ name: 'a.txt', blob: new Blob(['hello']) }, { name: 'dir/b.bin', blob: new Blob([r]) }]);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const es = lib.zipEntries(buf);
  assert.deepEqual(es.map((e) => [e.name, e.method, e.size, e.utf8, e.isDir]), [['a.txt', 0, 5, true, false], ['dir/b.bin', 0, 3000, true, false]]);
  assert.equal(text(await lib.zipRead(buf, es[0])), 'hello');
  assert.deepEqual(await lib.zipRead(buf, es[1]), r);
});

test('round-trips a deflated entry (node:zlib deflateRawSync)', both('zipEntries', 'zipRead'), async () => {
  const buf = docxLike();
  const es = lib.zipEntries(buf);
  assert.deepEqual(es.map((e) => e.name), ['[Content_Types].xml', 'docProps/core.xml', 'word/document.xml']);
  const core = es[1];
  assert.equal(core.method, 8);
  assert.ok(core.compSize > 0 && core.compSize !== core.size);
  assert.match(text(await lib.zipRead(buf, core)), /<dc:title>Smoke R&amp;D<\/dc:title>/);
  const doc = es[2];
  assert.ok(doc.compSize < doc.size / 4, 'repetitive text compresses');
  assert.equal(text(await lib.zipRead(buf, doc)).length, doc.size);
});

test('a UTF-8 name, a CP437 name, a directory and a comment', need('zipEntries'), () => {
  const buf = zipOf([
    { name: 'Año/', data: '' },
    { name: 'Año/niño ✓.txt', data: 'x' },
    { name: 'caf\x82.txt', data: 'y', utf8: false },   // 0x82 is é in CP437, invalid alone in UTF-8
  ], { comment: 'made by hand' });
  const es = lib.zipEntries(buf);
  assert.deepEqual(es.map((e) => [e.name, e.isDir]), [['Año/', true], ['Año/niño ✓.txt', false], ['café.txt', false]]);
  assert.equal(es[2].utf8, false);
});

test('an empty archive has no entries', need('zipEntries'), async () => {
  assert.deepEqual(lib.zipEntries(zipOf([])), []);
  const blob = await lib.makeZip([]);
  assert.deepEqual(lib.zipEntries(new Uint8Array(await blob.arrayBuffer())), []);
});

test('a truncated or foreign file throws', need('zipEntries'), () => {
  const buf = zipOf([{ name: 'a.txt', data: 'hello world' }]);
  assert.throws(() => lib.zipEntries(buf.subarray(0, buf.length - 10)), /ZIP/);
  assert.throws(() => lib.zipEntries(buf.subarray(0, 30)), /ZIP/);
  assert.throws(() => lib.zipEntries(new Uint8Array(10)), /ZIP/);
  assert.throws(() => lib.zipEntries(rand(4096)), /ZIP/);
  // A central directory that points past the file.
  const bad = Uint8Array.from(buf);
  const dv = new DataView(bad.buffer);
  dv.setUint32(bad.length - 6, 0x7fffffff, true);
  assert.throws(() => lib.zipEntries(bad), /ZIP/);
});

test('a local header offset past the end throws', need('zipEntries'), () => {
  const buf = zipOf([{ name: 'a.txt', data: 'hello' }]);
  const dv = new DataView(buf.buffer);
  const cd = dv.getUint32(buf.length - 6, true);
  dv.setUint32(cd + 42, buf.length + 100, true);
  assert.throws(() => lib.zipEntries(buf), /local header/);
});

test('the Zip64 locator path', both('zipEntries', 'zipRead'), async () => {
  const buf = zipOf([{ name: 'big.txt', data: 'zip64 says hi', deflate: true }, { name: 'b.txt', data: 'b' }], { zip64: true });
  const es = lib.zipEntries(buf);
  assert.deepEqual(es.map((e) => e.name), ['big.txt', 'b.txt']);
  assert.equal(text(await lib.zipRead(buf, es[0])), 'zip64 says hi');
  // A locator pointing nowhere is an error, not a guess.
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 22 - 20 + 8, 3, true);
  assert.throws(() => lib.zipEntries(buf), /Zip64/);
});

test('a self-extractor stub in front shifts every offset', need('zipEntries', 'zipRead'), async () => {
  const buf = zipOf([{ name: 'a.txt', data: 'stub ahead' }], { prefix: new Uint8Array(100).fill(0x90) });
  const es = lib.zipEntries(buf);
  assert.equal(es[0].offset, 100);
  assert.equal(text(await lib.zipRead(buf, es[0])), 'stub ahead');
});

test('CRC, size and method are checked', both('zipEntries', 'zipRead'), async () => {
  const buf = zipOf([{ name: 'a.txt', data: 'hello' }, { name: 'z.txt', data: 'zzzzzzzzzzzzzzzzzzzzzzzz', deflate: true }]);
  const es = lib.zipEntries(buf);
  await assert.rejects(lib.zipRead(buf, Object.assign({}, es[0], { crc: 1 })), /CRC/);
  assert.equal(text(await lib.zipRead(buf, Object.assign({}, es[0], { crc: 1 }), { verify: false })), 'hello');
  await assert.rejects(lib.zipRead(buf, Object.assign({}, es[0], { method: 12 })), /method 12/);
  await assert.rejects(lib.zipRead(buf, Object.assign({}, es[1], { size: 5 })), /declared size/);
  await assert.rejects(lib.zipRead(buf, Object.assign({}, es[1], { size: 1e12 })), /too large/);
  await assert.rejects(lib.zipRead(buf, Object.assign({}, es[0], { encrypted: true })), /encrypted/);
  await assert.rejects(lib.zipRead(buf, Object.assign({}, es[1], { dataOffset: es[0].dataOffset, compSize: 5 })), /deflate|declared|CRC/);
});
