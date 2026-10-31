// js/lib/zip.js: the store-only ZIP writer and its CRC-32.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, need } from './load.mjs';
import { crc32ref, rand } from './fixtures.mjs';

test('crc32 check value', need('crc32'), () => {
  assert.equal(lib.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  assert.equal(lib.crc32(new Uint8Array(0)), 0);
  const r = rand(5000);
  assert.equal(lib.crc32(r), crc32ref(r));
});

// Walks the archive from the end of central directory, as an unzipper does.
function readZip(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = buf.length - 22;
  assert.equal(v.getUint32(eocd, true), 0x06054b50, 'EOCD signature');
  const count = v.getUint16(eocd + 10, true);
  assert.equal(v.getUint16(eocd + 8, true), count);
  const cdSize = v.getUint32(eocd + 12, true), cdOff = v.getUint32(eocd + 16, true);
  assert.equal(cdOff + cdSize, eocd, 'central directory ends at the EOCD');
  const out = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    assert.equal(v.getUint32(p, true), 0x02014b50, 'central header signature');
    assert.equal(v.getUint16(p + 10, true), 0, 'stored');
    const crc = v.getUint32(p + 16, true), csize = v.getUint32(p + 20, true), size = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true), elen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nlen));
    assert.equal(v.getUint32(local, true), 0x04034b50, 'local header signature');
    assert.equal(v.getUint32(local + 14, true), crc, 'local CRC matches');
    const lname = v.getUint16(local + 26, true), lextra = v.getUint16(local + 28, true);
    const data = buf.subarray(local + 30 + lname + lextra, local + 30 + lname + lextra + csize);
    out.push({ name, crc, size, csize, data });
    p += 46 + nlen + elen + clen;
  }
  assert.equal(p, eocd);
  return out;
}

test('makeZip: names, sizes, CRCs and stored bytes round-trip', need('makeZip', 'crc32'), async () => {
  const inputs = [
    { name: 'a.txt', data: new TextEncoder().encode('hello zip') },
    { name: 'dir/página-1.png', data: rand(3000, 3) },
    { name: 'empty', data: new Uint8Array(0) },
  ];
  const blob = await lib.makeZip(inputs.map((e) => ({ name: e.name, blob: new Blob([e.data]) })));
  assert.equal(blob.type, 'application/zip');
  const got = readZip(new Uint8Array(await blob.arrayBuffer()));
  assert.equal(got.length, inputs.length);
  got.forEach((g, i) => {
    assert.equal(g.name, inputs[i].name);
    assert.equal(g.size, inputs[i].data.length);
    assert.equal(g.csize, g.size);
    assert.equal(g.crc, crc32ref(inputs[i].data));
    assert.deepEqual(Buffer.from(g.data), Buffer.from(inputs[i].data));
  });
});
