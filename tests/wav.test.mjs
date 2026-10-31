// js/lib/wav.js: 16-bit PCM WAV from anything shaped like an AudioBuffer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, need } from './load.mjs';

const fakeBuffer = (channels, sampleRate) => ({
  numberOfChannels: channels.length, sampleRate, length: channels[0].length,
  getChannelData: (c) => Float32Array.from(channels[c]),
});
const view = async (blob) => {
  const b = new Uint8Array(await blob.arrayBuffer());
  return { b, v: new DataView(b.buffer), s: (o, n) => Buffer.from(b.subarray(o, o + n)).toString('latin1') };
};

test('stereo: RIFF/WAVE/fmt/data headers and interleaved samples', need('encodeWav'), async () => {
  const blob = lib.encodeWav(fakeBuffer([[0, 1, -1], [0.5, -0.5, 2]], 44100));
  assert.equal(blob.type, 'audio/wav');
  const { b, v, s } = await view(blob);
  assert.equal(s(0, 4), 'RIFF');
  assert.equal(s(8, 4), 'WAVE');
  assert.equal(s(12, 4), 'fmt ');
  assert.equal(s(36, 4), 'data');
  assert.equal(v.getUint32(40, true), 3 * 2 * 2, 'data size');
  assert.equal(v.getUint32(4, true), b.length - 8, 'RIFF size');
  assert.equal(v.getUint16(20, true), 1, 'PCM');
  assert.equal(v.getUint16(22, true), 2, 'channels');
  assert.equal(v.getUint32(24, true), 44100);
  assert.equal(v.getUint32(28, true), 44100 * 4, 'byte rate');
  assert.equal(v.getUint16(32, true), 4, 'block align');
  assert.equal(v.getUint16(34, true), 16, 'bits');
  const pcm = Array.from({ length: 6 }, (_, i) => v.getInt16(44 + i * 2, true));
  assert.deepEqual(pcm, [0, 16383, 32767, -16384, -32768, 32767]);   // clipped at ±1
});

test('mono averages the channels', need('encodeWav'), async () => {
  const { v } = await view(lib.encodeWav(fakeBuffer([[1, 0.5], [0, -0.5]], 8000), { mono: true }));
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(40, true), 2 * 2);
  assert.equal(v.getUint32(28, true), 8000 * 2);
  assert.deepEqual([v.getInt16(44, true), v.getInt16(46, true)], [16383, 0]);
});
