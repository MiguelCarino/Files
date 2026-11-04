// Clip P0 encoder bench (docs/SCOPE-CLIP.md §4.2, §4.3, §7), driven by Playwright.
//
//   node tests/clip/bench.mjs --browser chromium|firefox [--fixtures a,b] [--codecs vp9,av1]
//                             [--budgets 2,4,6] [--hw prefer-software] [--timeout 900]
//                             [--frame-rate source] [--mode variable|constant] [--out-tag name] [--replace]
//                             [--quick] [--no-score]
//
// Serves the Files repo on 127.0.0.1:7397, opens tests/clip/bench.html, and for
// each fixture × codec × target bitrate encodes to WebM with the vendored
// Mediabunny. Each output is saved to tests/clip/results/<browser>/ and the
// measurements to tests/clip/results/<browser>/raw.json; then
// tests/clip/score.py adds SSIM (ffmpeg) and writes results/<browser>.json and
// results/<browser>.md.
//
// --out-tag name writes results/<browser><name>/ instead, so runs with other settings
// don't overwrite each other. A run whose --frame-rate or --mode differs from the
// raw.json already in its results folder stops unless --replace. The runs SCOPE-CLIP
// §12 cites, and the exact commands for them, are listed in §12.1.
//
// --quick: 2 fixtures (easy and hard, 720p30 5 s), VP9 only: a smoke check
// that the page loads and encodes. One browser at a time; below 3000 MB of
// available memory the run is skipped (shared machine).
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createReadStream, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { freemem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from './benchlib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FIXTURES = path.join(HERE, 'fixtures');
const RESULTS = path.join(HERE, 'results');
const PORT = Number(process.env.PORT || 7397);
const MIN_MB = Number(process.env.MIN_MB || 3000);

function args(argv) {
  const o = { browser: 'chromium', fixtures: null, codecs: null, budgets: null, hw: null, frameRate: null, mode: null, tag: null, replace: false, timeout: 900, quick: false, score: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--browser') o.browser = v();
    else if (a === '--fixtures') o.fixtures = v().split(',').filter(Boolean);
    else if (a === '--codecs') o.codecs = v().split(',').filter(Boolean);
    else if (a === '--budgets') o.budgets = v().split(',').map(Number).filter((n) => n > 0);
    else if (a === '--hw') o.hw = v();
    else if (a === '--timeout') o.timeout = Number(v());
    else if (a === '--frame-rate') o.frameRate = v();
    else if (a === '--out-tag') o.tag = v();
    else if (a === '--mode') o.mode = v();
    else if (a === '--replace') o.replace = true;
    else if (a === '--quick') o.quick = true;
    else if (a === '--no-score') o.score = false;
    else if (a === '-h' || a === '--help') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\nimport')[0]); process.exit(0); }
    else throw new Error('unknown argument ' + a);
  }
  if (!['chromium', 'firefox'].includes(o.browser)) throw new Error('--browser chromium|firefox');
  if (o.frameRate && o.frameRate !== 'source') throw new Error('--frame-rate source');
  if (o.mode && !['variable', 'constant'].includes(o.mode)) throw new Error('--mode variable|constant');
  if (o.tag && !/^[a-z]+$/.test(o.tag)) throw new Error('--out-tag: lowercase letters only');
  for (const c of o.codecs || []) if (!L.CODECS.includes(c)) throw new Error('codec ' + c + ': one of ' + L.CODECS.join(', '));
  if (o.hw && !['no-preference', 'prefer-hardware', 'prefer-software'].includes(o.hw)) throw new Error('--hw no-preference|prefer-hardware|prefer-software');
  return o;
}

function availableMb() {
  try {
    const m = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m);
    if (m) return Math.floor(Number(m[1]) / 1024);
  } catch { /* not Linux */ }
  return Math.floor(freemem() / 1048576);
}

function playwright() {
  const candidates = [path.join(ROOT, 'tests', 'smoke', 'node_modules', 'playwright'),
    path.resolve(ROOT, '..', 'Topo', 'tests', 'node_modules', 'playwright')];
  for (const c of candidates) if (existsSync(c)) return createRequire(import.meta.url)(c);
  return null;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
  '.srt': 'text/plain; charset=utf-8', '.ass': 'text/plain; charset=utf-8',
};

/* Static files from the repo root, plus POST /__bench/save?browser=&name= into results/<browser>/. */
function serve(port) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/__bench/save') {
      const browser = url.searchParams.get('browser') || '', name = url.searchParams.get('name') || '';
      if (!/^[a-z]+$/.test(browser) || !/^[\w.-]+\.webm$/.test(name)) { res.writeHead(400).end(); return; }
      const dir = path.join(RESULTS, browser);
      mkdirSync(dir, { recursive: true });
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { writeFileSync(path.join(dir, name), Buffer.concat(chunks)); res.writeHead(204).end(); });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(ROOT, rel || 'index.html');
    if (!file.startsWith(ROOT + path.sep) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    if (req.method === 'HEAD') res.end(); else createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const o = args(process.argv.slice(2));
  const avail = availableMb();
  if (avail < MIN_MB) { console.log(`SKIP bench: ${avail} MB available, needs ${MIN_MB} MB (shared machine)`); return 0; }
  const pw = playwright();
  if (!pw) { console.log('SKIP bench: no Playwright (tests/smoke/node_modules or ../Topo/tests/node_modules)'); return 0; }
  const mf = path.join(FIXTURES, 'manifest.json');
  if (!existsSync(mf)) { console.error('No fixtures: run python3 -I tools/clip_fixtures.py first'); return 2; }
  const fixtures = L.selectFixtures(L.parseManifest(readFileSync(mf, 'utf8')), { names: o.fixtures, quick: o.quick });
  const codecs = o.codecs || (o.quick ? L.QUICK_CODECS : L.CODECS);
  const jobs = L.planJobs(fixtures, { codecs, budgetsMiB: o.budgets || L.LADDER_MIB });
  console.log(`${o.browser}: ${fixtures.length} fixtures × ${codecs.join('/')} → ${jobs.length} encodes`);

  const runName = o.browser + (o.tag || '');
  const outDir = path.join(RESULTS, runName);
  const settings = { frameRate: o.frameRate || 'unset', bitrateMode: o.mode || 'variable' };
  const prevRaw = path.join(outDir, 'raw.json');
  if (existsSync(prevRaw) && !o.replace) {
    let prev = {};
    try { prev = JSON.parse(readFileSync(prevRaw, 'utf8')); } catch { /* unreadable: treat as different */ }
    const was = { frameRate: prev.frameRate || 'unset', bitrateMode: prev.bitrateMode || 'variable' };
    if (was.frameRate !== settings.frameRate || was.bitrateMode !== settings.bitrateMode) {
      console.error('results/' + runName + '/ holds a run with --frame-rate ' + was.frameRate + ' --mode ' + was.bitrateMode
        + '; this one is --frame-rate ' + settings.frameRate + ' --mode ' + settings.bitrateMode + '. '
        + 'Use --out-tag to keep both, or --replace to overwrite it.');
      return 2;
    }
  }
  mkdirSync(outDir, { recursive: true });
  const server = await serve(PORT);
  const errors = [];
  const external = [];
  const raw = { browser: o.browser, version: null, info: null, started: new Date().toISOString(), hw: o.hw || 'no-preference', ...settings, jobs: [] };
  const save = () => writeFileSync(path.join(outDir, 'raw.json'), JSON.stringify(raw, null, 2) + '\n');
  let browser;
  try {
    browser = await pw[o.browser].launch({ headless: true });
    raw.version = browser.version();
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let page;
    const open = async () => {
      page = await context.newPage();
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('request', (r) => { if (!r.url().startsWith(`http://127.0.0.1:${PORT}/`) && !/^(blob|data):/.test(r.url())) external.push(r.url()); });
      await page.goto(`http://127.0.0.1:${PORT}/tests/clip/bench.html`);
      await page.waitForFunction(() => window.benchReady === true, null, { timeout: 30000 });
    };
    await open();
    raw.info = await page.evaluate(() => window.benchInfo());
    for (const [i, job] of jobs.entries()) {
      // The frame-rate hint resamples to a constant rate, so VFR sources (fps 0) go without it.
      const cfr = (fixtures.find((f) => f.name === job.fixture) || {}).fps > 0;
      const full = { ...job, save: true, browser: runName, hw: o.hw || undefined, frameRate: (cfr && o.frameRate) || undefined, bitrateMode: o.mode || undefined };
      const t0 = Date.now();
      let r;
      try {
        r = await Promise.race([
          page.evaluate((j) => window.benchJob(j), full),
          new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${o.timeout} s`)), o.timeout * 1000)),
        ]);
      } catch (e) {
        r = { ok: false, error: String(e.message || e) };
        await page.close().catch(() => {});
        await open();
      }
      const row = { ...job, ...r, wallMs: Date.now() - t0 };
      delete row.url;
      raw.jobs.push(row);
      save();
      const tag = `[${i + 1}/${jobs.length}] ${job.out}`;
      if (r.ok) console.log(`ok   ${tag}  ${(r.actualVideoBps / 1000).toFixed(0)}/${(job.videoBps / 1000).toFixed(0)} kbps  overshoot ${r.overshoot.toFixed(3)}  overhead ${r.overheadPct.toFixed(2)}%  ${r.encodeFps.toFixed(1)} fps`);
      else console.log(`FAIL ${tag}  ${r.error}`);
    }
  } finally {
    raw.finished = new Date().toISOString();
    raw.consoleErrors = errors;
    raw.externalRequests = external;
    save();
    if (browser) await browser.close().catch(() => {});
    await new Promise((r) => server.close(r));
  }
  const failed = raw.jobs.filter((j) => !j.ok).length;
  console.log(`${raw.jobs.length - failed} ok, ${failed} failed; console errors ${errors.length}; outside requests ${external.length}`);
  if (external.length) console.log('outside requests: ' + external.join(', '));
  if (o.score) {
    const r = spawnSync('python3', ['-I', path.join(HERE, 'score.py'), '--browser', runName], { stdio: 'inherit' });
    if (r.status !== 0) console.log('score.py exited ' + r.status);
  }
  return failed || external.length ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(2); });
