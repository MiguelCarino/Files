// Clip P0 bench helpers (tests/clip/benchlib.mjs), their Python twin
// (tests/clip/cliplib.py), the fixture specs (tools/clip_fixtures.py) and the
// two test pages (tests/clip/bench.html, tests/smoke/codecs.html).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ROOT, read } from './load.mjs';
import * as L from './clip/benchlib.mjs';

const py = (args) => spawnSync('python3', ['-I', ...args], { cwd: ROOT, encoding: 'utf8' });
const noPython = (r) => r.error && r.error.code === 'ENOENT';

test('videoBitrateFor: limit × 0.99 − overhead guess − audio, floored to 1 kbps', () => {
  // 4 MiB over 5 s, silent: (4194304 × 0.985) × 8 / 5 = 6 610 000 (floored)
  assert.equal(L.videoBitrateFor(4 * L.MiB, 5), 6610000);
  // Opus 96k over 5 s takes 60 000 bytes out of the budget
  assert.equal(L.videoBitrateFor(4 * L.MiB, 5, 96000), 6514000);
  assert.equal(L.videoBitrateFor(4 * L.MiB, 5) % 1000, 0);
});

test('videoBitrateFor: clamps, and null when audio eats the budget', () => {
  assert.equal(L.videoBitrateFor(100 * L.MiB, 1), L.MAX_BPS);
  assert.equal(L.videoBitrateFor(2 * L.MiB, 600), L.MIN_BPS);
  assert.equal(L.videoBitrateFor(1 * L.MiB, 120, 96000), null);
  assert.throws(() => L.videoBitrateFor(0, 5), RangeError);
  assert.throws(() => L.videoBitrateFor(L.MiB, 0), RangeError);
});

test('bitrateLadder: one rung per limit, rising, duplicates dropped', () => {
  const l = L.bitrateLadder(30);
  assert.deepEqual(l.map((r) => r.limitMiB), [2, 4, 6]);
  assert.ok(l[0].videoBps < l[1].videoBps && l[1].videoBps < l[2].videoBps);
  assert.equal(l[1].limitBytes, 4194304);
  // Over 0.5 s even 2 MiB asks for ~33 Mbps: every rung clamps to the ceiling
  const short = L.bitrateLadder(0.5);
  assert.equal(short.length, 1, 'all three clamp to MAX_BPS: one rung');
  assert.equal(short[0].videoBps, L.MAX_BPS);
});

test('overshoot, container overhead, encode fps, bits per pixel', () => {
  assert.equal(L.requestedBytes(8000, 10), 10000);
  assert.equal(L.overshootFactor(11000, 8000, 10), 1.1);
  assert.ok(Number.isNaN(L.overshootFactor(5, 0, 10)));
  assert.deepEqual(L.containerOverhead(1000, 990), { bytes: 10, pct: 1 });
  assert.ok(Number.isNaN(L.containerOverhead(0, 0).pct));
  assert.equal(L.encodeFps(150, 5000), 30);
  assert.ok(Number.isNaN(L.encodeFps(150, 0)));
  // 1 Mbps at 1280×720×30 ≈ 0.0362 bpp (the §4.3 lines themselves live in docs/SCOPE-CLIP.md)
  assert.equal(L.bitsPerPixel(1e6, 1280, 720, 30).toFixed(4), '0.0362');
  assert.ok(Number.isNaN(L.bitsPerPixel(1e6, 0, 720, 30)));
  assert.equal(L.median([3, 1, 2]), 2);
  assert.equal(L.median([4, 1, NaN, 2, 3]), 2.5);
  assert.ok(Number.isNaN(L.median([])));
});

test('jobFile names an output by fixture, codec and limit', () => {
  assert.equal(L.jobFile('easy-720p30-5s', 'vp9', 4), 'easy-720p30-5s.vp9.4mib.webm');
  assert.equal(L.jobFile('x', 'av1', 1.5), 'x.av1.1_5mib.webm');
});

const FX = [
  { name: 'easy-720p30-5s', path: 'easy-720p30-5s.mp4', w: 1280, h: 720, fps: 30, duration: 5, kind: 'easy', notes: '', bench: true },
  { name: 'hard-720p30-5s', path: 'hard-720p30-5s.mp4', w: 1280, h: 720, fps: 30, duration: 5, kind: 'hard', notes: '' },
  { name: 'mixed-720p30-5s', path: 'mixed-720p30-5s.mp4', w: 1280, h: 720, fps: 30, duration: 5, kind: 'mixed', notes: '', audio: true },
  { name: 'vfr-720p-10s', path: 'vfr-720p-10s.mp4', w: 1280, h: 720, fps: 0, duration: 10, kind: 'vfr', notes: '' },
  { name: 'hlg', path: 'hlg.webm', w: 1920, h: 1080, fps: 30, duration: 5, kind: 'hdr', notes: '', bench: false },
];

test('parseManifest accepts good entries (fps 0 = VFR) and rejects bad ones', () => {
  assert.equal(L.parseManifest({ fixtures: FX }).length, 5);
  assert.equal(L.parseManifest(JSON.stringify({ fixtures: FX })).length, 5);
  assert.throws(() => L.parseManifest({}), /no fixtures/);
  assert.throws(() => L.parseManifest({ fixtures: [{ ...FX[0], w: 0 }] }), /bad w/);
  assert.throws(() => L.parseManifest({ fixtures: [{ ...FX[0], duration: '5' }] }), /bad duration/);
  assert.throws(() => L.parseManifest({ fixtures: [{ ...FX[0], kind: '' }] }), /bad kind/);
  assert.throws(() => L.parseManifest({ fixtures: [{ ...FX[0], path: '../x.mp4' }] }), /plain file name/);
  assert.throws(() => L.parseManifest({ fixtures: [FX[0], FX[0]] }), /duplicate/);
});

test('selectFixtures: names, the quick pair, or every bench entry', () => {
  assert.deepEqual(L.selectFixtures(FX, { quick: true }).map((f) => f.name), L.QUICK_FIXTURES);
  assert.deepEqual(L.selectFixtures(FX, { names: ['hlg'] }).map((f) => f.name), ['hlg']);
  assert.ok(!L.selectFixtures(FX).some((f) => f.name === 'hlg'), 'bench:false left out by default');
  assert.throws(() => L.selectFixtures(FX, { names: ['nope'] }), /clip_fixtures/);
});

test('planJobs: fixture × codec × rung, audio budget only with sound', () => {
  const jobs = L.planJobs(FX.slice(0, 3), { codecs: ['vp9', 'av1'] });
  assert.equal(jobs.length, 3 * 2 * 3);
  const mixed = jobs.find((j) => j.fixture === 'mixed-720p30-5s' && j.limitMiB === 4 && j.codec === 'vp9');
  assert.equal(mixed.audioBps, L.AUDIO_BPS);
  assert.equal(mixed.videoBps, 6514000);
  assert.equal(mixed.out, 'mixed-720p30-5s.vp9.4mib.webm');
  assert.equal(jobs.find((j) => j.fixture === 'easy-720p30-5s').audioBps, 0);
});

test('the Python ladder (native_ref.py) matches benchlib.mjs', () => {
  const durs = [1, 5, 10, 30, 60, 120, 7.5];
  const r = py(['tests/clip/native_ref.py', '--print-ladder', ...durs.map(String)]);
  if (noPython(r)) return;
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  for (const d of durs) {
    const k = Object.keys(got).find((x) => Number(x) === d);
    assert.deepEqual(got[k].silent, L.bitrateLadder(d), 'silent ' + d);
    assert.deepEqual(got[k].opus, L.bitrateLadder(d, { audioBps: L.AUDIO_BPS }), 'opus ' + d);
  }
});

test('tools/clip_fixtures.py --list --json: valid manifest entries covering §8', () => {
  const r = py(['tools/clip_fixtures.py', '--list', '--json']);
  if (noPython(r)) return;
  assert.equal(r.status, 0, r.stderr);
  const fx = L.parseManifest(r.stdout);
  const names = fx.map((f) => f.name);
  for (const n of L.QUICK_FIXTURES) assert.ok(names.includes(n), n);
  for (const kind of ['easy', 'hard', 'mixed', 'vfr', 'subtitles', 'hdr', 'odd', 'rotated']) {
    assert.ok(fx.some((f) => f.kind === kind), 'a ' + kind + ' fixture');
  }
  for (const d of [5, 30, 120]) assert.ok(fx.some((f) => f.duration === d), d + ' s');
  for (const [w, h, fps] of [[1280, 720, 30], [1920, 1080, 60], [3840, 2160, 24], [1918, 1080, 30]]) {
    assert.ok(fx.some((f) => f.w === w && f.h === h && f.fps === fps), `${w}x${h}@${fps}`);
  }
  assert.ok(fx.some((f) => f.hdr === 'pq') && fx.some((f) => f.hdr === 'hlg'), 'PQ and HLG');
  assert.ok(fx.some((f) => f.sidecar && f.sidecar.endsWith('.srt')), 'an SRT sidecar');
  assert.ok(fx.some((f) => f.container === 'mkv' && f.subtitles === 'ass'), 'MKV with ASS');
  assert.ok(fx.some((f) => f.rotation === 90), 'a display-matrix rotation');
  assert.ok(fx.every((f) => !f.hdr || f.bench === false), 'HDR fixtures are not in the default bench');
});

test('tools/clip_fixtures.py --only rejects an unknown name', () => {
  const r = py(['tools/clip_fixtures.py', '--only', 'no-such-fixture', '--list']);
  if (noPython(r)) return;
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown fixture/);
});

for (const page of ['tests/clip/bench.html', 'tests/smoke/codecs.html']) {
  test(page + ': no outside requests', () => {
    const html = read(page);
    const urls = [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
    for (const u of urls) assert.doesNotMatch(u, /^(?:https?:)?\/\//, u);
    for (const m of html.matchAll(/(?:import\s*\(|from\s+)\s*['"]([^'"]+)['"]/g)) assert.match(m[1], /^\.{1,2}\//, m[1]);
    assert.doesNotMatch(html, /fetch\(\s*['"`]https?:/);
    assert.match(html, /<meta name="viewport"/);
  });
}

test('bench.html loads the vendored Mediabunny and exposes the runner hooks', () => {
  const html = read('tests/clip/bench.html');
  assert.match(html, /\.\.\/\.\.\/vendor\/mediabunny\/mediabunny\.min\.mjs/);
  for (const k of ['window.benchJob', 'window.benchInfo', 'window.benchReady']) assert.ok(html.includes(k), k);
  assert.match(html, /bitrateMode: job\.bitrateMode \|\| 'variable'/);   // --mode constant overrides
  assert.match(html, /video\.frameRate = frameRateHint/);                  // --frame-rate source (§12.3)
});

test('codecs.html probes every §6 capability', () => {
  const html = read('tests/smoke/codecs.html');
  for (const k of ['VideoEncoder.isConfigSupported', 'AudioEncoder.isConfigSupported', 'VideoDecoder.isConfigSupported',
    'canPlayType', 'requestVideoFrameCallback', 'showSaveFilePicker', 'getDirectory', 'wakeLock', 'OffscreenCanvas',
    'webgl2', '(dynamic-range: high)', "'prefer-hardware'", "'prefer-software'", "'variable'", "'constant'"]) {
    assert.ok(html.includes(k), k);
  }
});
