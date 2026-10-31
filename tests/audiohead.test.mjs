// js/lib/audiohead.js: the source sample rate and channels from a header,
// so the WAV export decodes at the file's own rate (B-2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, need } from './load.mjs';
import { cat, pad, enc, wavPcm } from './fixtures.mjs';

const u16le = (n) => [n & 255, (n >> 8) & 255];
const u32le = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const u16be = (n) => [(n >> 8) & 255, n & 255];
const u32be = (n) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const sniff = (b) => lib.sniffAudioRate(b);
const N = need('sniffAudioRate');

test('WAV: the fmt chunk, after another chunk', N, () => {
  const fmt = [...u16le(1), ...u16le(1), ...u32le(22050), ...u32le(44100), ...u16le(2), ...u16le(16)];
  const b = cat('RIFF', u32le(0), 'WAVE', 'LIST', u32le(3), [1, 2, 3, 0], 'fmt ', u32le(16), fmt, 'data', u32le(0));
  assert.deepEqual(sniff(b), { rate: 22050, channels: 1 });
});

test('WAV: the smoke fixture builder writes the rate it was given', N, () => {
  assert.deepEqual(sniff(wavPcm({ rate: 22050, channels: 2, frames: 8 })), { rate: 22050, channels: 2 });
});

test('FLAC: STREAMINFO, also behind an ID3v2 tag', N, () => {
  // 96 kHz, 6 channels: 20 bits rate, then (channels − 1) in 3 bits.
  const rate = 96000, ch = 6;
  const si = [...u16be(4096), ...u16be(4096), 0, 0, 0, 0, 0, 0,
    (rate >> 12) & 255, (rate >> 4) & 255, ((rate & 15) << 4) | ((ch - 1) << 1), 0, ...pad(24)];
  const flac = cat('fLaC', [0x80, 0, 0, 34], si);
  assert.deepEqual(sniff(flac), { rate: 96000, channels: 6 });
  const id3 = cat('ID3', [3, 0, 0, 0, 0, 0, 4], pad(4));
  assert.deepEqual(sniff(cat(id3, flac)), { rate: 96000, channels: 6 });
});

// MPEG audio frame: sync, version, layer III, no CRC; bitrate, rate, pad; mode.
const mpegFrame = (verBits, brIdx, srIdx, mono) => [0xFF, 0xE0 | (verBits << 3) | (1 << 1) | 1, (brIdx << 4) | (srIdx << 2), mono ? 0xC0 : 0x00];
test('MP3: MPEG1, MPEG2 and MPEG2.5 rates and the channel mode', N, () => {
  assert.deepEqual(sniff(Uint8Array.from([...mpegFrame(3, 9, 0, false), 1, 2, 3])), { rate: 44100, channels: 2 });
  assert.deepEqual(sniff(Uint8Array.from([...mpegFrame(2, 8, 0, true), 1, 2, 3])), { rate: 22050, channels: 1 });
  assert.deepEqual(sniff(Uint8Array.from([...mpegFrame(0, 8, 2, true), 1, 2, 3])), { rate: 8000, channels: 1 });
});

test('MP3: after an ID3v2 tag, and two frames in a row must agree', N, () => {
  const tag = [...enc('ID3'), 3, 0, 0, 0, 0, 0, 2, 0, 0];
  const h = mpegFrame(3, 9, 1, false);   // 128 kbps @ 48 kHz → 384-byte frames
  const two = [...h, ...pad(380), ...h, ...pad(8)];
  assert.deepEqual(sniff(Uint8Array.from([...tag, ...two])), { rate: 48000, channels: 2 });
  // A stray sync whose "next frame" is not one is skipped.
  const stray = [...h, ...pad(380), 0x12, 0x34, ...pad(8)];
  assert.equal(sniff(Uint8Array.from(stray)), null);
});

const oggPage = (packet) => cat('OggS', [0, 2], pad(8), pad(4), pad(4), pad(4), [1, packet.length], packet);
test('Ogg Vorbis: the id header rate', N, () => {
  const vorbis = cat([1], 'vorbis', u32le(0), [2], u32le(32000), pad(12), [0xB8, 1]);
  assert.deepEqual(sniff(oggPage(vorbis)), { rate: 32000, channels: 2 });
});

test('Ogg Opus: always 48 kHz, whatever the input rate says', N, () => {
  const opus = cat('OpusHead', [1, 1], u16le(312), u32le(44100), u16le(0), [0]);
  assert.deepEqual(sniff(oggPage(opus)), { rate: 48000, channels: 1 });
});

// moov/trak/mdia/minf/stbl/stsd/mp4a/esds with an AudioSpecificConfig.
const box = (type, ...body) => { const b = cat(...body); return cat(u32be(b.length + 8), type, b); };
const m4a = (aot, sfi, cfg, entry = 'mp4a', extra = []) => {
  const ascBytes = [(aot << 3) | (sfi >> 1), ((sfi & 1) << 7) | (cfg << 3), ...extra];
  const dsi = [5, ascBytes.length, ...ascBytes];
  const dcd = [4, 13 + dsi.length, 0x40, 0x15, 0, 0, 0, ...u32be(0), ...u32be(0), ...dsi];
  const es = [3, 3 + dcd.length, 0, 1, 0, ...dcd];
  const esds = box('esds', [0, 0, 0, 0], es);
  const sampleEntry = box(entry, pad(6), u16be(1), pad(8), u16be(2), u16be(16), pad(4), u32be(44100 << 16 >>> 0), esds);
  const stsd = box('stsd', [0, 0, 0, 0], u32be(1), sampleEntry);
  return cat(box('ftyp', 'M4A ', u32be(0)), box('moov', box('trak', box('mdia', box('minf', box('stbl', stsd))))));
};
test('M4A: AAC-LC rate from the AudioSpecificConfig', N, () => {
  assert.deepEqual(sniff(m4a(2, 4, 2)), { rate: 44100, channels: 2 });
  assert.deepEqual(sniff(m4a(2, 3, 1)), { rate: 48000, channels: 1 });
});

test('M4A: HE-AAC and other sample entries are left to the decoder (null)', N, () => {
  assert.equal(sniff(m4a(5, 7, 2)), null);
  assert.equal(sniff(m4a(2, 4, 2, 'alac')), null);
});

test('M4A: a half-rate AAC-LC core may be implicit HE-AAC (null) unless the sync extension says', N, () => {
  // 24 kHz core, no extension: the decoder may double it with SBR.
  assert.equal(sniff(m4a(2, 6, 2)), null);
  assert.equal(sniff(m4a(2, 7, 1)), null);
  // Sync extension 0x2B7, extension AOT 5, sbrPresent 1, extension rate 48 kHz (index 3).
  // Bits: 01010110111 00101 1 0011 + pad → 0x56 0xE5 0x98 (after the 16 core bits).
  assert.deepEqual(sniff(m4a(2, 6, 2, 'mp4a', [0x56, 0xE5, 0x98])), { rate: 48000, channels: 2 });
  // sbrPresent 0: really AAC-LC at 24 kHz.
  assert.deepEqual(sniff(m4a(2, 6, 2, 'mp4a', [0x56, 0xE5, 0x00])), { rate: 24000, channels: 2 });
});

test('unknown or empty bytes give null', N, () => {
  assert.equal(sniff(new Uint8Array(0)), null);
  assert.equal(sniff(cat('%PDF-1.7', pad(64))), null);
  assert.equal(sniff(cat('RIFF', u32le(4), 'WAVE')), null);
});
