// js/lib/hashes.js: the pasted-digest detector and the incremental MD5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { lib, need } from './load.mjs';

const enc = (s) => new TextEncoder().encode(s);
const md5 = (bytes, chunks) => {
  const st = lib.md5Init();
  if (!chunks) lib.md5Update(st, bytes);
  else for (let i = 0; i < bytes.length; i += chunks) lib.md5Update(st, bytes.subarray(i, i + chunks));
  return lib.md5Digest(st);
};

test('MD5: the RFC 1321 test suite', need('md5Init', 'md5Update', 'md5Digest'), () => {
  const vectors = [
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', '0cc175b9c0f1b6a831c399e269772661'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
    ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
    ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', '57edf4a22be3c955ac49da2e2107b67a'],
  ];
  for (const [s, hex] of vectors) assert.equal(md5(enc(s)), hex, JSON.stringify(s));
});

test('MD5: matches node:crypto across block edges and chunk sizes', need('md5Init'), () => {
  for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 4096 + 13, 70000]) {
    const b = new Uint8Array(randomBytes(n));
    const want = createHash('md5').update(b).digest('hex');
    assert.equal(md5(b), want, 'one update, n=' + n);
    for (const c of [1, 7, 64, 333]) assert.equal(md5(b, c), want, 'chunks of ' + c + ', n=' + n);
  }
});

test('detectHashAlgo: the algorithm from the length', need('detectHashAlgo'), () => {
  const d = lib.detectHashAlgo;
  const h = (n) => 'a1'.repeat(n / 2);
  assert.deepEqual(d(h(32)), { algo: 'MD5', hex: h(32) });
  assert.deepEqual(d(h(40)), { algo: 'SHA-1', hex: h(40) });
  assert.deepEqual(d(h(64)), { algo: 'SHA-256', hex: h(64) });
  assert.deepEqual(d(h(128)), { algo: 'SHA-512', hex: h(128) });
  for (const n of [0, 30, 31, 33, 48, 63, 65, 96, 127, 129]) assert.equal(d('b'.repeat(n)), null, 'length ' + n);
});

test('detectHashAlgo: trims, lowercases, strips prefixes, reads sum lines', need('detectHashAlgo'), () => {
  const d = lib.detectHashAlgo;
  const hex = createHash('sha256').update('x').digest('hex');
  const m5 = createHash('md5').update('x').digest('hex');
  assert.deepEqual(d('  ' + hex.toUpperCase() + '\n'), { algo: 'SHA-256', hex });
  assert.deepEqual(d('sha256:' + hex), { algo: 'SHA-256', hex });
  assert.deepEqual(d('SHA-256: ' + hex), { algo: 'SHA-256', hex });
  assert.deepEqual(d('sha256=' + hex), { algo: 'SHA-256', hex });
  assert.deepEqual(d('md5:' + m5), { algo: 'MD5', hex: m5 });
  assert.deepEqual(d(hex + '  ubuntu.iso'), { algo: 'SHA-256', hex });
  assert.deepEqual(d(hex + ' *ubuntu.iso'), { algo: 'SHA-256', hex });
  assert.deepEqual(d('SHA256 (ubuntu.iso) = ' + hex), { algo: 'SHA-256', hex });
  assert.deepEqual(d(hex + '  a.iso\n' + m5 + '  b.iso'), { algo: 'SHA-256', hex }, 'the first line');
});

test('detectHashAlgo: refuses what is not a hash', need('detectHashAlgo'), () => {
  const d = lib.detectHashAlgo;
  const hex = createHash('sha256').update('x').digest('hex');
  assert.equal(d(''), null);
  assert.equal(d(null), null);
  assert.equal(d('hello world'), null);
  assert.equal(d('g'.repeat(64)), null, 'not hex');
  assert.equal(d('md5:' + hex), null, 'the prefix disagrees with the length');
  assert.equal(d('crc32:' + hex), null, 'an unknown prefix');
  assert.equal(d('0x' + hex.slice(2)), null);
});
