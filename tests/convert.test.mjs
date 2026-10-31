// js/lib/convert.js: the rail's settings map onto an in-browser conversion
// the same way they map onto the ffmpeg command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, need } from './load.mjs';

test('codec → Mediabunny codec, container and file name', need('convertPlan'), () => {
  const p = lib.convertPlan({ input: 'holiday clip.MOV', codec: 'vp9' }, { width: 1920, height: 1080 });
  assert.equal(p.videoCodec, 'vp9');
  assert.equal(p.container, 'webm');
  assert.equal(p.mime, 'video/webm');
  assert.equal(p.output, 'holiday clip_encoded.webm');
  for (const [c, v] of [['h264', 'avc'], ['hevc', 'hevc'], ['av1', 'av1']]) {
    const q = lib.convertPlan({ input: 'a.mkv', codec: c });
    assert.equal(q.videoCodec, v); assert.equal(q.container, 'mp4'); assert.equal(q.output, 'a_encoded.mp4');
  }
  assert.equal(lib.convertPlan({ input: 'C:\\x\\clip.avi' }).output, 'clip_encoded.mp4');
  assert.equal(lib.convertPlan({}).output, 'input_encoded.mp4');
});

test('CRF maps onto five quality steps on a 0–51 scale', need('convertQuality'), () => {
  assert.equal(lib.convertQuality(23, 51), 'HIGH');
  assert.equal(lib.convertQuality(0, 51), 'VERY_HIGH');
  assert.equal(lib.convertQuality(18, 51), 'VERY_HIGH');
  assert.equal(lib.convertQuality(28, 51), 'MEDIUM');
  assert.equal(lib.convertQuality(35, 51), 'LOW');
  assert.equal(lib.convertQuality(51, 51), 'VERY_LOW');
  // VP9/AV1 software sliders run to 63: their usual ~30 is HIGH, not MEDIUM.
  assert.equal(lib.convertQuality(30, 63), 'HIGH');
  assert.equal(lib.convertQuality(63, 63), 'VERY_LOW');
  assert.equal(lib.convertPlan({ codec: 'av1', gpu: 'none', q: 30 }).quality, 'HIGH');
});

test('resolution only ever downscales, to an even width', need('convertSize', 'convertPlan'), () => {
  assert.deepEqual(lib.convertSize('720', { width: 1920, height: 1080 }), { width: 1280, height: 720, kept: false });
  // 4:3 at 480p → 640; an odd result rounds to even.
  assert.equal(lib.convertSize('480', { width: 1440, height: 1080 }).width, 640);
  assert.equal(lib.convertSize('480', { width: 1001, height: 1000 }).width % 2, 0);
  assert.deepEqual(lib.convertSize('1080', { width: 1280, height: 720 }), { width: null, height: null, kept: true });
  assert.deepEqual(lib.convertSize('original', { width: 1280, height: 720 }), { width: null, height: null, kept: false });
  const p = lib.convertPlan({ res: '1080' }, { width: 640, height: 360 });
  assert.equal(p.height, null);
  assert.ok(p.notes.some((n) => /already 1080p/.test(n)), p.notes.join(' | '));
});

test('audio settings, and AAC in WebM becomes Opus', need('convertPlan'), () => {
  assert.deepEqual(lib.convertPlan({ audio: 'copy' }).audio, {});
  assert.deepEqual(lib.convertPlan({ audio: 'none' }).audio, { discard: true });
  assert.deepEqual(lib.convertPlan({ audio: 'opus' }).audio, { codec: 'opus', bitrate: 128000, numberOfChannels: 2 });
  assert.deepEqual(lib.convertPlan({ audio: 'aac' }).audio, { codec: 'aac', bitrate: 192000 });
  const w = lib.convertPlan({ codec: 'vp9', audio: 'aac' });
  assert.equal(w.audio.codec, 'opus');
  assert.ok(w.notes.some((n) => /AAC/.test(n)));
});

test('command-only settings are called out, defaults stay quiet', need('convertPlan'), () => {
  assert.deepEqual(lib.convertPlan({ codec: 'h264', gpu: 'none', audio: 'copy', res: 'original' }).notes, []);
  assert.equal(lib.convertPlan({ gpu: 'nvidia', twopass: true }).notes.length, 2);
});
