// js/lib/sha256.js against node:crypto, across chunkings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { lib, need } from './load.mjs';

const ref = (b) => createHash('sha256').update(b).digest('hex');
const ours = (b, chunk) => {
  const st = lib.sha256Init();
  if (!b.length) lib.sha256Update(st, b);
  for (let i = 0; i < b.length; i += chunk) lib.sha256Update(st, b.subarray(i, i + chunk));
  return lib.sha256Digest(st);
};
const N = ['sha256Init', 'sha256Update', 'sha256Digest'];

test('known vectors', need(...N), () => {
  const u8 = (s) => new Uint8Array(Buffer.from(s));
  assert.equal(ours(u8(''), 1), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(ours(u8('abc'), 1), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(ours(u8('abc'), 64), ref(u8('abc')));
});

test('every length 0..200 around the padding boundary, odd chunkings', need(...N), () => {
  const rnd = new Uint8Array(randomBytes(256));
  for (let L = 0; L <= 200; L++) for (const c of [1, 7, 55, 56, 64, 65]) {
    const b = rnd.subarray(0, L);
    assert.equal(ours(b, c), ref(b), 'len ' + L + ' chunk ' + c);
  }
});

test('1 MiB and 3 MiB inputs in several chunk sizes', need(...N), () => {
  const mib = new Uint8Array(1 << 20).fill(0x61);
  for (const c of [63, 64, 65, 4 << 20]) assert.equal(ours(mib, c), ref(mib), 'chunk ' + c);
  const rnd = new Uint8Array(randomBytes(3 << 20));
  for (const c of [1 << 20, 65, 1000003]) assert.equal(ours(rnd, c), ref(rnd), 'chunk ' + c);
});
