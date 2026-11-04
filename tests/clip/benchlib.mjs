// Pure helpers for the Clip P0 bench (docs/SCOPE-CLIP.md §4.2, §4.3, §7).
// Imported by tests/clip/bench.html (in the browser), tests/clip/bench.mjs (the
// Playwright runner) and tests/clipbench.test.mjs (node --test). No DOM, no I/O.
//
// tests/clip/cliplib.py has a Python twin of bitrateLadder for the native
// ffmpeg reference; tests/clipbench.test.mjs checks the two agree.

export const MiB = 1048576;

// The bench's size targets, in MiB. 4 and 6 MiB are the imageboard limits the
// scope starts from; 2 MiB adds a starved rung so the bits-per-pixel table
// reaches the "visibly blocky" end.
export const LADDER_MIB = [2, 4, 6];

// §4.2's budget: limit × 0.99, minus container overhead (a guess here, ~0.5%;
// P0 measures the real figure), minus the audio.
export const SAFETY = 0.99;
export const OVERHEAD_GUESS = 0.005;
export const MIN_BPS = 64000;
export const MAX_BPS = 25000000;
export const AUDIO_BPS = 96000;      // Opus, when the source has sound

export const CODECS = ['vp9', 'av1', 'vp8'];   // the WebM ladder (§6.3 rule 2)
export const QUICK_FIXTURES = ['easy-720p30-5s', 'hard-720p30-5s'];
export const QUICK_CODECS = ['vp9'];

/** Video bits per second for a byte limit, or null when audio + margins eat it all. */
export function videoBitrateFor(limitBytes, durationS, audioBps = 0, opts = {}) {
  const { safety = SAFETY, overhead = OVERHEAD_GUESS, min = MIN_BPS, max = MAX_BPS } = opts;
  if (!(limitBytes > 0) || !(durationS > 0)) throw new RangeError('limit and duration must be > 0');
  const budget = limitBytes * safety - limitBytes * overhead - (audioBps * durationS) / 8;
  if (budget <= 0) return null;
  const bps = Math.floor((budget * 8) / durationS / 1000) * 1000;
  return Math.max(min, Math.min(max, bps));
}

/** One rung per limit: [{ limitMiB, limitBytes, videoBps }], duplicates (after clamping) dropped. */
export function bitrateLadder(durationS, { budgetsMiB = LADDER_MIB, audioBps = 0 } = {}) {
  const out = [];
  const seen = new Set();
  for (const m of budgetsMiB) {
    const limitBytes = Math.round(m * MiB);
    const videoBps = videoBitrateFor(limitBytes, durationS, audioBps);
    if (videoBps == null || seen.has(videoBps)) continue;
    seen.add(videoBps);
    out.push({ limitMiB: m, limitBytes, videoBps });
  }
  return out;
}

/** Bytes the encoder was asked for: bitrate × duration. */
export const requestedBytes = (bps, durationS) => (bps * durationS) / 8;

/** Actual video bytes / requested video bytes (> 1 = overshoot). */
export function overshootFactor(actualBytes, bps, durationS) {
  const want = requestedBytes(bps, durationS);
  return want > 0 ? actualBytes / want : NaN;
}

/** Container overhead: file bytes − Σ packet bytes, and that as a % of the file. */
export function containerOverhead(fileBytes, packetBytes) {
  const bytes = fileBytes - packetBytes;
  return { bytes, pct: fileBytes > 0 ? (bytes / fileBytes) * 100 : NaN };
}

/** Frames per second of wall time. */
export const encodeFps = (frames, ms) => (ms > 0 ? (frames * 1000) / ms : NaN);

/** §4.3: bits per pixel = bitrate / (width × height × fps). */
export function bitsPerPixel(bps, w, h, fps) {
  return w > 0 && h > 0 && fps > 0 ? bps / (w * h * fps) : NaN;
}

/** The output name a job saves under: <fixture>.<codec>.<n>mib.webm */
export function jobFile(fixture, codec, limitMiB) {
  return `${fixture}.${codec}.${String(limitMiB).replace('.', '_')}mib.webm`;
}

const REQUIRED = { name: 'string', path: 'string', kind: 'string', notes: 'string' };
const NUMERIC = ['w', 'h', 'fps', 'duration'];

/** Validate tools/clip_fixtures.py's manifest.json (or its --list --json); returns the entries. */
export function parseManifest(doc) {
  const obj = typeof doc === 'string' ? JSON.parse(doc) : doc;
  if (!obj || !Array.isArray(obj.fixtures)) throw new TypeError('manifest: no fixtures array');
  const names = new Set();
  for (const f of obj.fixtures) {
    for (const [k, t] of Object.entries(REQUIRED)) {
      if (typeof f[k] !== t || (k !== 'notes' && !f[k])) throw new TypeError(`manifest: ${f.name || '?'}: bad ${k}`);
    }
    for (const k of NUMERIC) {
      // fps 0 marks a variable-frame-rate source.
      if (typeof f[k] !== 'number' || !(f[k] >= 0) || (k !== 'fps' && f[k] === 0)) {
        throw new TypeError(`manifest: ${f.name}: bad ${k}`);
      }
    }
    if (!/^[\w.-]+$/.test(f.path)) throw new TypeError(`manifest: ${f.name}: path must be a plain file name`);
    if (names.has(f.name)) throw new TypeError(`manifest: duplicate ${f.name}`);
    names.add(f.name);
  }
  return obj.fixtures;
}

/** The fixtures a run covers: named ones, the quick pair, or every bench:true entry. */
export function selectFixtures(fixtures, { names = null, quick = false } = {}) {
  if (names && names.length) {
    const by = new Map(fixtures.map((f) => [f.name, f]));
    const missing = names.filter((n) => !by.has(n));
    if (missing.length) throw new Error('not in the manifest (run tools/clip_fixtures.py): ' + missing.join(', '));
    return names.map((n) => by.get(n));
  }
  if (quick) return selectFixtures(fixtures, { names: QUICK_FIXTURES });
  return fixtures.filter((f) => f.bench !== false);
}

/** Every job of a run: fixture × codec × rung. */
export function planJobs(fixtures, { codecs = CODECS, budgetsMiB = LADDER_MIB } = {}) {
  const jobs = [];
  for (const f of fixtures) {
    const audioBps = f.audio ? AUDIO_BPS : 0;
    for (const codec of codecs) {
      for (const r of bitrateLadder(f.duration, { budgetsMiB, audioBps })) {
        jobs.push({
          fixture: f.name, src: f.path, codec, audioBps,
          limitMiB: r.limitMiB, limitBytes: r.limitBytes, videoBps: r.videoBps,
          out: jobFile(f.name, codec, r.limitMiB),
        });
      }
    }
  }
  return jobs;
}

/** Median of the finite numbers in xs (NaN when there are none). */
export function median(xs) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
