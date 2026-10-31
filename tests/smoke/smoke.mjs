// The Files smoke run: one headless Chromium, one context, the real page.
// Started by tests/smoke/run.sh, which serves the repo and sets BASE.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { realPng, withExifGps, wavPcm, docxLike, CERT_PEM } from '../fixtures.mjs';
import { PDFLib } from '../pdflib.mjs';

// require() honours NODE_PATH (run.sh points it at Topo's copy); import does not.
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8743/';
const tmp = mkdtempSync(path.join(tmpdir(), 'files-smoke-'));
let pass = 0, fail = 0;
const check = (ok, name, info) => {
  if (ok) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (info !== undefined ? ' -- ' + (typeof info === 'string' ? info : JSON.stringify(info)) : '')); }
};

const errors = [];      // console errors and page errors, every page
const requests = [];    // [page label, URL] for every request
const browser = await chromium.launch({ headless: true });
try {
  // Service workers blocked here: the steps below test the page itself, and a
  // worker installed by one step must not answer the next. The offline steps
  // (P9, at the end) get a fresh context of their own.
  const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
  const watch = (page, label) => {
    page.on('console', (m) => { if (m.type() === 'error') errors.push(label + ': ' + m.text()); });
    page.on('pageerror', (e) => errors.push(label + ': ' + e.message));
    page.on('request', (r) => requests.push([label, r.url()]));
    return page;
  };
  const vendorReqs = (label) => [...new Set(requests
    .filter(([l, u]) => (!label || l === label) && u.includes('/vendor/'))
    .map(([, u]) => u.slice(u.indexOf('/vendor/') + 1)))];

  /* ── 1 · the bare page ── */
  const page = watch(await context.newPage(), 'home');
  await page.goto(BASE + '?lang=en', { waitUntil: 'networkidle' });
  check(errors.length === 0, 'page loads with no console errors', errors);
  const slices = await page.$$eval('#modules .slice', (els) => els.map((e) => e.dataset.id));
  check(slices.length === 5 && slices.includes('metadata'), '#modules has 5 slices including metadata', slices);
  check(vendorReqs('home').length === 0, 'no vendor/ request before a file is given', vendorReqs('home'));

  /* ── 2 · a PNG on the file screen, then the metadata workspace ── */
  const pngPath = path.join(tmp, 'dot.png');
  writeFileSync(pngPath, realPng());
  await page.setInputFiles('#auto-input', pngPath);
  let ok = await page.waitForFunction(() => /PNG/.test(document.querySelector('#auto-details').textContent), null, { timeout: 10000 }).then(() => true, () => false);
  check(ok, '#auto-details names PNG', await page.textContent('#auto-details'));
  const cards = await page.$$eval('#auto-outcomes .oc-card', (els) => els.map((e) => e.textContent));
  check(cards.some((t) => t.includes('Inspect / edit metadata')), "outcome cards include 'Inspect / edit metadata'", cards);
  await page.locator('#auto-outcomes .oc-card', { hasText: 'Inspect / edit metadata' }).click();
  ok = await page.waitForFunction(() => document.querySelector('#tool-metadata.active') && document.querySelector('#md-groups').children.length > 0, null, { timeout: 10000 }).then(() => true, () => false);
  check(ok, 'metadata workspace active with groups rendered', await page.evaluate(() => location.hash));
  await page.waitForLoadState('networkidle');
  // OCR waits for Extract text (O-1): a PNG on the file screen fetches no
  // Tesseract and no model. Of the metadata libraries only exifr may load.
  const v = vendorReqs('home');
  check(v.some((u) => u.startsWith('vendor/metadata/exifr'))
    && v.every((u) => u.startsWith('vendor/metadata/exifr')),
    'vendor requests: exifr only (no vendor/tesseract, no vendor/tessdata before Extract text)', v);

  // A real JPEG for step 4, made by this browser's encoder.
  const jpegB64 = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = c.height = 16;
    const g = c.getContext('2d'); g.fillStyle = '#c84'; g.fillRect(0, 0, 16, 16);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  });
  await page.close();

  /* ── 3 · straight to #metadata ── */
  const md = watch(await context.newPage(), 'metadata');
  await md.goto(BASE + '?lang=en#metadata', { waitUntil: 'networkidle' });
  check(await md.isVisible('#md-empty'), '#metadata starts on its empty state');
  await md.setInputFiles('#md-input', pngPath);
  ok = await md.waitForFunction(() => document.querySelector('#md-groups').children.length > 0, null, { timeout: 10000 }).then(() => true, () => false);
  const hash = await md.evaluate(() => location.hash);
  check(ok && hash === '#metadata', '#md-input renders and stays on #metadata', hash);
  await md.waitForLoadState('networkidle');
  const mv = vendorReqs('metadata');
  check(mv.length >= 1 && mv.every((u) => u.startsWith('vendor/metadata/exifr')), 'opened in #metadata: vendor requests are exifr only (no OCR)', mv);
  await md.close();

  /* ── 4 · a JPEG with GPS: advisory, then a clean copy ── */
  const jpgPath = path.join(tmp, 'where.jpg');
  writeFileSync(jpgPath, withExifGps(Buffer.from(jpegB64, 'base64')));
  const gp = watch(await context.newPage(), 'gps');
  await gp.goto(BASE + '?lang=en', { waitUntil: 'networkidle' });
  await gp.setInputFiles('#auto-input', jpgPath);
  ok = await gp.waitForFunction(() => /GPS location/.test(document.querySelector('#auto-alert').textContent), null, { timeout: 15000 }).then(() => true, () => false);
  check(ok, 'a GPS advisory is shown for the JPEG', await gp.textContent('#auto-alert'));
  const [download] = await Promise.all([
    gp.waitForEvent('download', { timeout: 15000 }),
    gp.locator('#auto-outcomes .oc-card', { hasText: 'Clean copy for sharing' }).click(),
  ]);
  const out = readFileSync(await download.path());
  const src = readFileSync(jpgPath);
  const exifApp1 = (b) => { // any APP1 Exif segment before the scan
    for (let p = 2; p + 4 <= b.length;) {
      if (b[p] !== 0xFF) return false;
      const m = b[p + 1];
      if (m === 0xDA || m === 0xD9) return false;
      if (m === 0xE1 && b.toString('latin1', p + 4, p + 9) === 'Exif\0') return true;
      p += 2 + b.readUInt16BE(p + 2);
    }
    return false;
  };
  check(exifApp1(src) && out[0] === 0xFF && out[1] === 0xD8 && !exifApp1(out),
    'Clean copy for sharing downloads a JPEG with no Exif APP1', { name: download.suggestedFilename(), bytes: out.length });
  await gp.close();

  /* ── 5 · the transcode route ── */
  const tc = watch(await context.newPage(), 'transcode');
  await tc.goto(BASE + '?lang=en#transcode', { waitUntil: 'networkidle' });
  const cmd = (await tc.textContent('#tc-cmd')) || '';
  check(/^ffmpeg -y -i 'input\.mkv'/.test(cmd.trim()) && await tc.isVisible('#tool-transcode'), '#transcode renders a command', cmd.slice(0, 80));
  await tc.close();

  /* ── 6 · the shell (P1): card cap and More, mode route fallback, runtime
     labels across a language switch, the phone fold, the Signature primary ── */
  const capCheck = async (pg, cap, label) => {
    const r = await pg.$$eval('#auto-outcomes .oc-card', (els) => ({
      cards: els.filter((e) => !e.classList.contains('oc-more')).length,
      more: els.filter((e) => e.classList.contains('oc-more')).length,
      last: (els.filter((e) => !e.classList.contains('oc-more')).pop() || {}).dataset?.oc,
      ords: els.map((e) => e.querySelector('.oc-n').textContent),
    }));
    check(r.cards <= cap && r.more <= 1 && r.last === 'metadata'
      && r.ords.every((n, i) => n === String(i + 1)),
      label + `: at most ${cap} cards, More only on overflow, metadata last, ordinals in order`, r);
    return r;
  };
  const sh = watch(await context.newPage(), 'shell');
  await sh.setViewportSize({ width: 1280, height: 900 });
  await sh.goto(BASE + '?lang=en', { waitUntil: 'networkidle' });
  await sh.setInputFiles('#auto-input', pngPath);
  await sh.waitForSelector('#auto-outcomes .oc-card', { timeout: 10000 });
  await capCheck(sh, 4, 'PNG at 1280px');
  // A JPEG with no GPS: "Remove location only" waits behind More.
  const plainJpg = path.join(tmp, 'plain.jpg');
  writeFileSync(plainJpg, Buffer.from(jpegB64, 'base64'));
  await sh.setInputFiles('#auto-input', plainJpg);
  await sh.waitForFunction(() => /JPEG/.test(document.querySelector('#auto-meta').textContent), null, { timeout: 10000 }).catch(() => {});
  await sh.waitForSelector('#auto-outcomes .oc-more', { timeout: 10000 }).catch(() => {});
  const jr = await capCheck(sh, 4, 'JPEG at 1280px');
  check(jr.more === 1, 'JPEG without GPS: a More tile holds Remove location only', jr);
  if (jr.more) {
    await sh.click('#auto-outcomes .oc-more');
    const open = await sh.$eval('#auto-outcomes .oc-more', (b) => ({ exp: b.getAttribute('aria-expanded'), t: b.textContent, gps: !!document.querySelector('#auto-outcomes .oc-card[data-oc="gps"]') }));
    check(open.exp === 'true' && /Less/.test(open.t) && open.gps, 'More expands in place and reads Less', open);
    await sh.click('#auto-outcomes .oc-more');   // and folds again
  }
  await sh.setViewportSize({ width: 360, height: 780 });
  await sh.waitForTimeout(150);
  await capCheck(sh, 3, 'JPEG at 360px');
  const fold = await sh.$eval('#auto-conv details.rail-fold', (d) => ({ open: d.open, sum: d.querySelector('summary').textContent.replace(/\s+/g, ' ').trim() }));
  check(fold.open === true, 'a panel opened above 640px is left open when the viewport narrows (set once at init)', fold);
  const noHScroll = await sh.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check(noHScroll, 'no page-level horizontal scroll at 360px');
  await sh.close();

  const ph = watch(await context.newPage(), 'phone');
  await ph.setViewportSize({ width: 360, height: 780 });
  await ph.goto(BASE + '?lang=en', { waitUntil: 'networkidle' });
  await ph.setInputFiles('#auto-input', pngPath);
  await ph.waitForSelector('#auto-outcomes .oc-card', { timeout: 10000 });
  const pf = await ph.$eval('#auto-conv details.rail-fold', (d) => ({ open: d.open, sum: d.querySelector('summary').textContent.replace(/\s+/g, ' ').trim(), vis: getComputedStyle(d.querySelector('.rs-vals')).display }));
  check(pf.open === false && /Convert/.test(pf.sum) && /WebP/.test(pf.sum) && /85%/.test(pf.sum) && /Strip/.test(pf.sum) && pf.vis !== 'none',
    'at 360px #auto-conv is a closed <details> whose summary reads Convert · WebP · 85% · Strip', pf);
  const sticky = await ph.$eval('#auto-result .pane-bar', (b) => getComputedStyle(b).position);
  check(sticky === 'sticky', 'at 360px the pane-bar is sticky', sticky);
  await capCheck(ph, 3, 'PNG at 360px');
  await ph.close();

  const rt = watch(await context.newPage(), 'route');
  await rt.goto(BASE + '?lang=en#file/xyz', { waitUntil: 'networkidle' });
  const rs = await rt.evaluate(() => ({ auto: document.querySelector('#tool-auto').classList.contains('active'),
    lit: document.querySelector('#modules .slice[data-id="file"]').classList.contains('active'), hash: location.hash }));
  check(rs.auto && rs.lit && errors.filter((e) => e.startsWith('route:')).length === 0, '#file/xyz falls back to the file screen with no console error', rs);
  await rt.close();

  const lg = watch(await context.newPage(), 'lang');
  await lg.goto(BASE + '?lang=en', { waitUntil: 'networkidle' });
  await lg.setInputFiles('#auto-input', pngPath);
  await lg.waitForSelector('#ac-go:not(.hidden)', { timeout: 10000 });
  await Promise.all([lg.waitForEvent('download', { timeout: 15000 }).catch(() => null), lg.click('#ac-go')]);
  await lg.waitForFunction(() => document.querySelector('#ac-state').dataset.tk, null, { timeout: 10000 }).catch(() => {});
  const before = await lg.textContent('#ac-state');
  await lg.evaluate(() => window.CarinoLang && window.CarinoLang.set('es'));
  await lg.waitForTimeout(200);
  const after = await lg.evaluate(() => ({ t: document.querySelector('#ac-state').textContent, tk: document.querySelector('#ac-state').dataset.tk }));
  check(!!after.tk && /EXIF quitado/.test(after.t) && after.t !== before, 'switching to es after a conversion keeps #ac-state translated', { before, after });
  await lg.evaluate(() => window.CarinoLang && window.CarinoLang.set('en'));
  await lg.close();

  const sg = watch(await context.newPage(), 'signature');
  await sg.goto(BASE + '?lang=en#signature', { waitUntil: 'networkidle' });
  const dl = await sg.evaluate(() => ({ t: document.querySelector('#sig-dl').textContent.trim(), menu: document.querySelector('#sig-export').classList.contains('hidden') }));
  check(dl.t === 'Download PNG' && dl.menu, "#sig-dl reads 'Download PNG'; the Export menu waits for 2 images", dl);
  await sg.close();

  /* ── 7 · P2 bug fixes: Signature (B-1), Audio → WAV (B-2), custom fields (B-4) ── */
  const sf = watch(await context.newPage(), 'sigfix');
  await sf.setViewportSize({ width: 1280, height: 900 });
  await sf.goto(BASE + '?lang=en#signature', { waitUntil: 'networkidle' });
  check(await sf.$eval('#sig-eundo', (b) => b.disabled), '#sig-eundo is disabled with nothing to undo');
  // A white card with one thick dark stroke through its middle.
  const inkB64 = await sf.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 240; c.height = 120;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 240, 120);
    g.strokeStyle = '#111'; g.lineWidth = 14; g.beginPath(); g.moveTo(20, 60); g.lineTo(220, 60); g.stroke();
    return c.toDataURL('image/png').split(',')[1];
  });
  const inkPath = path.join(tmp, 'ink.png');
  writeFileSync(inkPath, Buffer.from(inkB64, 'base64'));
  const svg0 = path.join(tmp, 'empty.svg');
  writeFileSync(svg0, '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"></svg>');
  await sf.setInputFiles('#sig-input', [inkPath, svg0]);
  ok = await sf.waitForFunction(() => document.querySelectorAll('#sig-strip .sig-thumb').length === 2
    && document.querySelectorAll('#sig-strip .sig-thumb-err').length === 1
    && /empty\.svg/.test(document.querySelector('#sig-statline').textContent), null, { timeout: 10000 }).then(() => true, () => false);
  check(ok, 'Signature: a PNG + a 0×0 SVG settle within 10 s, 2 thumbs, one in the error state, the stat line names the SVG',
    await sf.evaluate(() => ({ thumbs: document.querySelectorAll('#sig-strip .sig-thumb').length, stat: document.querySelector('#sig-statline').textContent })));
  // Erase across the middle of the stroke, then move the despeckle slider.
  const alphaMid = () => sf.evaluate(() => {
    const c = document.querySelector('#sig-stage canvas.sig-canvas:not(.hidden)');
    return c ? c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data[3] : -1;
  });
  const aBefore = await alphaMid();
  await sf.click('#sig-etgl');
  const box = await sf.locator('#sig-stage canvas.sig-canvas:not(.hidden)').boundingBox();
  if (box) {
    await sf.mouse.move(box.x + box.width / 2 - 4, box.y + box.height / 2);
    await sf.mouse.down();
    await sf.mouse.move(box.x + box.width / 2 + 4, box.y + box.height / 2, { steps: 4 });
    await sf.mouse.up();
  }
  const erased = await alphaMid();
  const undoOn = await sf.$eval('#sig-eundo', (b) => !b.disabled);
  await sf.$eval('#sig-spk', (s) => { s.value = '60'; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); });
  const aAfter = await alphaMid();
  check(aBefore > 0 && erased === 0 && aAfter === 0 && undoOn,
    'Signature: an erased spot stays transparent after the despeckle slider moves; undo is enabled', { aBefore, erased, aAfter, undoOn });
  await sf.close();

  const wv = watch(await context.newPage(), 'wav22k');
  await wv.goto(BASE + '?lang=en#transcode', { waitUntil: 'networkidle' });
  const wavPath = path.join(tmp, 'tone22k.wav');
  writeFileSync(wavPath, wavPcm({ rate: 22050, channels: 1, frames: 4410 }));
  await wv.setInputFiles('#wav-input', wavPath);
  ok = await wv.waitForFunction(() => /22\.05 kHz/.test(document.querySelector('#wav-info').textContent), null, { timeout: 10000 }).then(() => true, () => false);
  check(ok, "Transcode: a 22050 Hz WAV reads '22.05 kHz' in #wav-info", await wv.textContent('#wav-info'));
  const [wdl] = await Promise.all([wv.waitForEvent('download', { timeout: 15000 }).catch(() => null), wv.click('#wav-export')]);
  const wout = wdl ? readFileSync(await wdl.path()) : Buffer.alloc(0);
  check(wout.length > 44 && wout.readUInt32LE(24) === 22050, 'Transcode: the exported WAV header rate is 22050', wout.length > 28 ? wout.readUInt32LE(24) : wout.length);
  await wv.close();

  const mf = watch(await context.newPage(), 'mdfields');
  await mf.goto(BASE + '?lang=en#metadata', { waitUntil: 'networkidle' });
  const pdfB64 = await mf.evaluate(async () => {
    await needLib('PDFLib');
    const d = await PDFLib.PDFDocument.create(); d.addPage(); d.setTitle('Smoke');
    const b = await d.save(); let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  });
  const pdfPath = path.join(tmp, 'fields.pdf');
  writeFileSync(pdfPath, Buffer.from(pdfB64, 'base64'));
  await mf.setInputFiles('#md-input', pdfPath);
  await mf.waitForFunction(() => /Document Info/.test(document.querySelector('#md-groups').textContent), null, { timeout: 15000 }).catch(() => {});
  await mf.click('#md-add-field');
  await mf.fill('#md-add-key', 'ProjectCode');
  const pdfHint = await mf.textContent('#md-add-hint');
  await mf.fill('#md-add-val', 'X1');
  await mf.click('#md-add-ok');
  const [pdl] = await Promise.all([mf.waitForEvent('download', { timeout: 15000 }).catch(() => null), mf.click('#md-download')]);
  if (pdl) await mf.setInputFiles('#md-input', await pdl.path());
  ok = await mf.waitForFunction(() => [...document.querySelectorAll('#md-groups tr')].some((tr) => /ProjectCode/.test(tr.textContent)
    && (tr.querySelector('input') || {}).value === 'X1'), null, { timeout: 15000 }).then(() => true, () => false);
  check(/custom PDF property/.test(pdfHint || '') && ok, "Metadata: a PDF custom field 'ProjectCode' = 'X1' is saved and read back", { pdfHint, downloaded: !!pdl });
  await mf.setInputFiles('#md-input', plainJpg);
  await mf.waitForFunction(() => /Editable EXIF/.test(document.querySelector('#md-groups').textContent), null, { timeout: 15000 }).catch(() => {});
  await mf.click('#md-add-field');
  await mf.fill('#md-add-key', 'Foo');
  const jf = await mf.evaluate(() => ({ dis: document.querySelector('#md-add-ok').disabled, hint: document.querySelector('#md-add-hint').textContent, shown: !document.querySelector('#md-add-hint').hidden }));
  check(jf.dis && jf.shown && /JPEG can't store “Foo”/.test(jf.hint), "Metadata: on a JPEG the name 'Foo' disables Add and shows the hint", jf);
  await mf.close();

  /* ── P3 · native readers: X.509 (no node-forge), ZIP (no JSZip), EXIF carry
     from the head only ── */
  const ce = watch(await context.newPage(), 'cert');
  await ce.goto(BASE + '?lang=en#metadata', { waitUntil: 'networkidle' });
  const p384Path = path.join(tmp, 'p384.pem');
  writeFileSync(p384Path, CERT_PEM.p384);
  await ce.setInputFiles('#md-input', p384Path);
  ok = await ce.waitForFunction(() => /ECDSA P-384/.test(document.querySelector('#md-groups').textContent), null, { timeout: 10000 }).then(() => true, () => false);
  const certRows = await ce.$$eval('#md-groups tr', (trs) => trs.map((tr) => tr.textContent.replace(/\s+/g, ' ').trim()).filter((t) => /algorithm|Subject/.test(t)));
  await ce.waitForLoadState('networkidle');
  check(ok && certRows.some((t) => /Signature algorithm.*ECDSA with SHA-384/.test(t)) && !vendorReqs('cert').some((u) => /forge/.test(u)),
    "Metadata: an EC P-384 PEM shows 'ECDSA P-384' and its signature algorithm, with no vendor/metadata/forge request", { certRows, vendor: vendorReqs('cert') });
  const docxPath = path.join(tmp, 'report.docx');
  writeFileSync(docxPath, docxLike());
  await ce.setInputFiles('#md-input', docxPath);
  ok = await ce.waitForFunction(() => /Office Properties/.test(document.querySelector('#md-groups').textContent)
    && [...document.querySelectorAll('#md-groups td, #md-groups input')].some((e) => /Smoke R&D/.test(e.value || e.textContent)), null, { timeout: 10000 }).then(() => true, () => false);
  await ce.waitForLoadState('networkidle');
  check(ok && !vendorReqs('cert').some((u) => /jszip/i.test(u)), 'Metadata: a DOCX-like ZIP renders Office Properties (deflated core.xml) with no JSZip request',
    { groups: await ce.$$eval('#md-groups h3', (hs) => hs.map((h) => h.textContent)), vendor: vendorReqs('cert') });
  await ce.close();

  // Keep metadata on a JPEG → JPEG conversion: the output has EXIF, and the
  // source File is never read whole (no File.arrayBuffer() on it after the
  // click; the head and at most one span slice are Blob reads).
  const ex = watch(await context.newPage(), 'exifcarry');
  await ex.addInitScript(() => {
    window.__reads = [];
    const ab = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () { window.__reads.push(this instanceof File ? 'file:' + this.name : 'blob:' + this.size); return ab.call(this); };
  });
  await ex.setViewportSize({ width: 1280, height: 900 });
  await ex.goto(BASE + '?lang=en', { waitUntil: 'networkidle' });
  await ex.setInputFiles('#auto-input', jpgPath);
  await ex.waitForSelector('#ac-go:not(.hidden)', { timeout: 10000 });
  await ex.waitForTimeout(500);   // let the SHA-256 of the drop finish its own read first
  await ex.click('label[for="ac-fmt-jpg"]');
  await ex.click('label[for="ac-meta-keep"]');
  await ex.evaluate(() => { window.__reads = []; });
  const [cdl] = await Promise.all([ex.waitForEvent('download', { timeout: 15000 }).catch(() => null), ex.click('#ac-go')]);
  const carried = cdl ? readFileSync(await cdl.path()) : Buffer.alloc(0);
  const reads = await ex.evaluate(() => window.__reads);
  const failed = await ex.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.responseStatus >= 400).map((e) => e.name));
  check(exifApp1(carried) && !reads.includes('file:where.jpg') && failed.length === 0,
    'Images: Keep metadata on JPEG → JPEG carries EXIF without reading the source whole', { bytes: carried.length, reads, failed });
  await ex.close();

  /* ── P4 · OCR on click (O-1), Fast/Best (O-2), searchable PDF (F-2) ── */
  const oc = watch(await context.newPage(), 'ocr');
  await oc.setViewportSize({ width: 1280, height: 900 });
  await oc.goto(BASE + '?lang=en', { waitUntil: 'networkidle' });
  const textB64 = await oc.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 640; c.height = 160;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 640, 160);
    g.fillStyle = '#000'; g.font = 'bold 64px sans-serif'; g.textBaseline = 'middle'; g.fillText('HELLO 42', 40, 80);
    return c.toDataURL('image/png').split(',')[1];
  });
  const textPng = path.join(tmp, 'hello.png');
  writeFileSync(textPng, Buffer.from(textB64, 'base64'));
  await oc.setInputFiles('#auto-input', textPng);
  await oc.waitForSelector('#auto-view-acts:not(.hidden) #av-ocr', { timeout: 10000 }).catch(() => {});
  await oc.waitForLoadState('networkidle');
  const tessBefore = vendorReqs('ocr').filter((u) => /^vendor\/(tesseract|tessdata)\//.test(u));
  check(tessBefore.length === 0 && await oc.isHidden('#auto-ocr') && await oc.isVisible('#av-ocr'),
    'a PNG drop shows Extract text, keeps #auto-ocr hidden and requests nothing under vendor/tesseract or vendor/tessdata', tessBefore);
  const ocrOpts = await oc.evaluate(() => ({ open: document.querySelector('details.ocr-opts').open, fast: document.querySelector('#ocr-model-fast').checked }));
  check(!ocrOpts.open && ocrOpts.fast, 'OCR Options start closed and Fast is the model', ocrOpts);
  await oc.click('#av-ocr');
  ok = await oc.waitForFunction(() => /^Done/.test(document.querySelector('#ao-state').textContent), null, { timeout: 90000 }).then(() => true, () => false);
  check(ok && await oc.isVisible('#auto-ocr') && vendorReqs('ocr').includes('vendor/tessdata/fast/eng.traineddata.gz'),
    'Extract text opens #auto-ocr, runs, and fetches vendor/tessdata/fast/eng.traineddata.gz',
    { state: await oc.textContent('#ao-state'), text: (await oc.textContent('#ao-text')).slice(0, 40), vendor: vendorReqs('ocr') });
  const [sdl] = await Promise.all([oc.waitForEvent('download', { timeout: 60000 }).catch(() => null), oc.click('#ocr-pdf')]);
  const spdf = sdl ? readFileSync(await sdl.path()) : Buffer.alloc(0);
  check(spdf.toString('latin1', 0, 4) === '%PDF' && spdf.includes('/Font') && /\.searchable\.pdf$/.test(sdl ? sdl.suggestedFilename() : ''),
    'Searchable PDF from an image downloads <name>.searchable.pdf with a /Font text layer', { name: sdl && sdl.suggestedFilename(), bytes: spdf.length });
  // Options → Best: the next run fetches the full model, not the fast one.
  await oc.click('details.ocr-opts summary');
  await oc.click('label[for="ocr-model-best"]');
  await oc.waitForFunction(() => /^Ready/.test(document.querySelector('#ao-state').textContent), null, { timeout: 15000 }).catch(() => {});
  await oc.click('#ocr-run');
  ok = await oc.waitForFunction(() => /^Done/.test(document.querySelector('#ao-state').textContent), null, { timeout: 120000 }).then(() => true, () => false);
  check(ok && vendorReqs('ocr').includes('vendor/tessdata/eng.traineddata.gz') && /HELLO/i.test(await oc.textContent('#ao-text')),
    'Options → Best re-runs with vendor/tessdata/eng.traineddata.gz and reads the text',
    { state: await oc.textContent('#ao-state'), text: (await oc.textContent('#ao-text')).slice(0, 40) });
  await oc.click('label[for="ocr-model-fast"]');   // the choice is remembered: put Fast back
  // A PDF with no text on page 1 (a drawn box, no words): Make searchable is
  // among the visible cards, not behind More.
  const scanB64 = await oc.evaluate(async () => {
    await needLib('PDFLib');
    const d = await PDFLib.PDFDocument.create();
    const pg = d.addPage([300, 200]);
    pg.drawRectangle({ x: 40, y: 40, width: 200, height: 100, color: PDFLib.rgb(0.2, 0.2, 0.2) });
    const b = await d.save(); let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  });
  const scanPdf = path.join(tmp, 'scan.pdf');
  writeFileSync(scanPdf, Buffer.from(scanB64, 'base64'));
  await oc.setInputFiles('#auto-input', scanPdf);
  ok = await oc.waitForSelector('#auto-outcomes .oc-card[data-oc="searchable"]', { timeout: 15000 }).then(() => true, () => false);
  const scanCards = await oc.$$eval('#auto-outcomes .oc-card', (els) => els.map((e) => e.dataset.oc));
  check(ok && await oc.$eval('#auto-outcomes .oc-more', (b) => b.getAttribute('aria-expanded') !== 'true').catch(() => true),
    'a PDF with no text shows the Make searchable card among the visible cards', scanCards);
  await oc.close();

  /* ── 8 · P5: the batch tray (set view, spec §9) ── */
  const tr = watch(await context.newPage(), 'tray');
  await tr.setViewportSize({ width: 1280, height: 900 });
  await tr.goto(BASE + '?lang=en', { waitUntil: 'networkidle' });
  const trayRows = () => tr.evaluate(() => ({
    rows: document.querySelectorAll('#auto-tray .file-chip').length,
    shown: !document.querySelector('#auto-tray').classList.contains('hidden'),
  }));
  await tr.setInputFiles('#auto-input', [pngPath, scanPdf, jpgPath]);
  ok = await tr.waitForFunction(() => document.querySelectorAll('#auto-tray .file-chip').length === 3
    && !document.querySelector('#auto-tray').classList.contains('hidden'), null, { timeout: 10000 }).then(() => true, () => false);
  await tr.waitForSelector('#auto-outcomes .oc-card[data-oc="convert-all"]', { timeout: 10000 }).catch(() => {});
  const ts = await tr.evaluate(() => ({
    badge: document.querySelector('#set-count').textContent.trim(),
    cards: [...document.querySelectorAll('#auto-outcomes .oc-card')].map((c) => c.dataset.oc + ':' + c.textContent),
    drop: document.querySelector('#auto-drop .d-title').textContent,
    conv: getComputedStyle(document.querySelector('#auto-conv')).display,
    details: getComputedStyle(document.querySelector('#auto-details')).display,
    chip: document.querySelector('#auto-name').textContent,
  }));
  check(ok && ts.badge === '3 files' && ts.cards.some((t) => t.includes('Clean all')) && ts.cards.some((t) => t.includes('Convert images'))
    && /Add files/.test(ts.drop) && ts.conv === 'none' && ts.details === 'none' && ts.chip === '3 files',
    "3 files: #auto-tray has 3 rows, badge '3 files', cards Clean all + Convert images, dropzone reads Add files, no single-file panels", ts);
  await tr.click('#auto-tray .file-chip:nth-child(1) .tray-open');
  ok = await tr.waitForFunction(() => {
    const b = document.querySelector('#set-back');
    return !b.classList.contains('hidden') && b.textContent.trim() === '← 3 files'
      && document.querySelector('#auto-tray').classList.contains('hidden');
  }, null, { timeout: 10000 }).then(() => true, () => false);
  check(ok, "a tray row opens single view with the chip '← 3 files'", await tr.textContent('#set-back'));
  await tr.click('#set-back');
  ok = await tr.waitForFunction(() => document.querySelectorAll('#auto-tray .file-chip').length === 3
    && !document.querySelector('#auto-tray').classList.contains('hidden'), null, { timeout: 10000 }).then(() => true, () => false);
  check(ok, 'the chip returns to the 3 rows', await trayRows());
  await tr.click('#set-export-btn');
  const [csvDl] = await Promise.all([tr.waitForEvent('download', { timeout: 30000 }).catch(() => null), tr.click('#set-export-csv')]);
  const csvText = csvDl ? readFileSync(await csvDl.path(), 'utf8') : '';
  check(!!csvDl && csvDl.suggestedFilename() === 'files-metadata.csv' && csvText.split('\n').length >= 2 && /^"file","type","size","MIME"/.test(csvText),
    'Export ▾ → Metadata as CSV downloads files-metadata.csv with a header and one line per file',
    { name: csvDl && csvDl.suggestedFilename(), lines: csvText.split('\n').length });
  const [zipDl] = await Promise.all([tr.waitForEvent('download', { timeout: 30000 }).catch(() => null),
    tr.locator('#auto-outcomes .oc-card[data-oc="clean-all"]').click()]);
  const cleanZip = zipDl ? readFileSync(await zipDl.path()) : Buffer.alloc(0);
  ok = await tr.waitForFunction(() => [...document.querySelectorAll('#auto-tray .f-meta')].filter((m) => /✓ Done/.test(m.textContent)).length === 3,
    null, { timeout: 15000 }).then(() => true, () => false);
  check(!!zipDl && zipDl.suggestedFilename() === 'clean-copies.zip' && cleanZip[0] === 0x50 && cleanZip[1] === 0x4B && ok,
    "Clean all downloads clean-copies.zip (PK) and the 3 rows read '✓ Done'",
    { name: zipDl && zipDl.suggestedFilename(), metas: await tr.$$eval('#auto-tray .f-meta', (els) => els.map((e) => e.textContent)) });
  await tr.click('#auto-tray .file-chip:nth-child(1) .f-x');
  await tr.click('#auto-tray .file-chip:nth-child(1) .f-x');
  ok = await tr.waitForFunction(() => FilesApp.state.set === null && !!FilesApp.state.file
    && document.querySelector('#auto-tray').classList.contains('hidden')
    && document.querySelector('#set-count').classList.contains('hidden')
    && document.querySelector('#set-back').classList.contains('hidden'), null, { timeout: 10000 }).then(() => true, () => false);
  check(ok, 'removing rows down to 1 shows that file in single view', await trayRows());
  await tr.waitForLoadState('networkidle');
  const trv = vendorReqs('tray');
  check(!trv.some((u) => u.startsWith('vendor/tesseract') || u.startsWith('vendor/tessdata')), 'no vendor/tesseract or tessdata request in the tray flow', trv);
  await tr.close();

  /* ── P6 · Verify (F-6, spec §8) and Compare (F-4, spec §11) ── */
  const cp = watch(await context.newPage(), 'compare');
  await cp.goto(BASE + '?lang=en', { waitUntil: 'networkidle' });
  const cmpPngBytes = realPng();
  const cmpPng = path.join(tmp, 'cmp.png');
  writeFileSync(cmpPng, cmpPngBytes);
  await cp.setInputFiles('#auto-input', cmpPng);
  ok = await cp.waitForFunction(() => !!document.querySelector('#auto-details .fd-sha .fd-verify-chip'), null, { timeout: 10000 }).then(() => true, () => false);
  check(ok, 'the SHA-256 row gains the Verify chip', await cp.textContent('#auto-details'));
  await cp.click('#auto-details .fd-verify-chip');
  const verifyOut = (re) => cp.waitForFunction((src) => new RegExp(src).test(document.querySelector('#fd-verify .fd-verify-out').textContent),
    re.source, { timeout: 10000 }).then(() => true, () => false);
  await cp.fill('#fd-verify .input', 'ab'.repeat(32));
  check(await verifyOut(/No match · SHA-256/), "Verify: a wrong 64-hex reads 'No match · SHA-256'", await cp.textContent('#fd-verify'));
  const digest = (await cp.textContent('#auto-details .fd-sha-hex')).trim();
  // A paste of the right digest outside any field opens Verify with it.
  await cp.evaluate((hex) => {
    if (document.activeElement) document.activeElement.blur();
    const dt = new DataTransfer();
    dt.setData('text/plain', hex);
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, digest);
  check(await verifyOut(/^Match · SHA-256$/) && (await cp.inputValue('#fd-verify .input')) === digest,
    "Verify: pasting the digest (read from .fd-sha) reads 'Match · SHA-256'", { digest, out: await cp.textContent('#fd-verify') });
  await cp.fill('#fd-verify .input', createHash('md5').update(cmpPngBytes).digest('hex'));
  check(await verifyOut(/^Match · MD5$/), "Verify: the right 32-hex MD5 reads 'Match · MD5'", await cp.textContent('#fd-verify'));
  await cp.press('#fd-verify .input', 'Escape');
  check(await cp.evaluate(() => document.querySelector('#fd-verify').classList.contains('hidden')), 'Esc closes the Verify row');

  // Two files: the Compare set card leads; it opens #file/compare.
  await cp.click('#auto-clear');
  const cmpJpg = path.join(tmp, 'cmp.jpg');
  writeFileSync(cmpJpg, Buffer.from(jpegB64, 'base64'));
  await cp.setInputFiles('#auto-input', [cmpPng, cmpJpg]);
  ok = await cp.waitForFunction(() => {
    const c = document.querySelector('#auto-outcomes .oc-card');
    return c && c.dataset.oc === 'compare';
  }, null, { timeout: 10000 }).then(() => true, () => false);
  check(ok, 'two files: Compare is the first visible card',
    await cp.$$eval('#auto-outcomes .oc-card', (els) => els.map((e) => e.dataset.oc)));
  await cp.click('#auto-outcomes .oc-card[data-oc="compare"]');
  ok = await cp.waitForFunction(() => location.hash === '#file/compare'
    && document.querySelector('#tool-compare.active')
    && document.querySelector('#modules .slice[data-id="file"]').classList.contains('active')
    && /Different files/.test(document.querySelector('#cmp-verdict').textContent)
    && document.querySelectorAll('#cmp-table tbody tr.diff').length >= 1, null, { timeout: 15000 }).then(() => true, () => false);
  check(ok, "Compare: #file/compare with File lit, 'Different files' and at least 1 .diff row",
    await cp.evaluate(() => ({ hash: location.hash, verdict: document.querySelector('#cmp-verdict').textContent, diffs: document.querySelectorAll('#cmp-table tr.diff').length })));
  await cp.waitForFunction(() => !document.querySelector('#cmp-export-btn').disabled, null, { timeout: 15000 }).catch(() => {});
  await cp.click('#cmp-export-btn');
  const [cmpCsv] = await Promise.all([cp.waitForEvent('download', { timeout: 15000 }).catch(() => null), cp.click('#cmp-export-csv')]);
  const cmpCsvText = cmpCsv ? readFileSync(await cmpCsv.path(), 'utf8') : '';
  check(!!cmpCsv && cmpCsv.suggestedFilename() === 'comparison.csv' && /^"group","field","A: cmp\.png","B: cmp\.jpg","same"/.test(cmpCsvText),
    'Compare: Export ▾ → Comparison as CSV downloads comparison.csv', { name: cmpCsv && cmpCsv.suggestedFilename(), head: cmpCsvText.split('\n')[0] });
  await cp.click('#tool-compare .mode-done');
  ok = await cp.waitForFunction(() => location.hash === '#file' && document.querySelector('#tool-auto.active'), null, { timeout: 10000 }).then(() => true, () => false);
  check(ok, 'Compare: Done returns to #file', await cp.evaluate(() => location.hash));

  // A direct link: two empty slots; the same bytes under two names are identical.
  await cp.goto('about:blank');   // a real load, not a same-document hash change
  await cp.goto(BASE + '?lang=en#file/compare', { waitUntil: 'networkidle' });
  const empty = await cp.evaluate(() => ({
    a: !document.querySelector('#cmp-drop-a').classList.contains('hidden'),
    b: !document.querySelector('#cmp-drop-b').classList.contains('hidden'),
    verdict: document.querySelector('#cmp-verdict').textContent,
  }));
  check(empty.a && empty.b && /Choose/.test(empty.verdict), '#file/compare by link shows two empty slots', empty);
  const twin = path.join(tmp, 'cmp-copy.png');
  writeFileSync(twin, cmpPngBytes);
  await cp.setInputFiles('#cmp-input-a', cmpPng);
  await cp.setInputFiles('#cmp-input-b', twin);
  ok = await cp.waitForFunction(() => /Identical bytes/.test(document.querySelector('#cmp-verdict').textContent), null, { timeout: 15000 }).then(() => true, () => false);
  check(ok, "Compare: two copies of the same bytes read 'Identical bytes'", await cp.textContent('#cmp-verdict'));
  await cp.click('label[for="cmp-view-all"]');
  await cp.setViewportSize({ width: 360, height: 740 });
  await cp.waitForTimeout(300);
  const sw = await cp.evaluate(() => document.documentElement.scrollWidth);
  check(sw <= 360, 'Compare at 360 px: no horizontal page scroll', sw);
  await cp.close();

  /* ── P7 · Pages mode (F-3, spec §10) and the PDF clean copy (B-6, §13) ── */
  const mkPdf = async (n, w) => {
    const d = await PDFLib.PDFDocument.create();
    for (let i = 0; i < n; i++) d.addPage([w + i * 10, 400]);
    return Buffer.from(await d.save());
  };
  const p3 = path.join(tmp, 'three.pdf'), p2 = path.join(tmp, 'two.pdf');
  writeFileSync(p3, await mkPdf(3, 300));
  writeFileSync(p2, await mkPdf(2, 500));
  const pg = watch(await context.newPage(), 'pages');
  await pg.setViewportSize({ width: 1280, height: 900 });
  await pg.goto(BASE + '?lang=en', { waitUntil: 'networkidle' });
  await pg.setInputFiles('#auto-input', [p3, p2]);
  ok = await pg.waitForSelector('#auto-outcomes .oc-card[data-oc="merge-pdfs"]', { timeout: 15000 }).then(() => true, () => false);
  check(ok, 'two PDFs: the set view offers Merge PDFs',
    await pg.$$eval('#auto-outcomes .oc-card', (els) => els.map((e) => e.dataset.oc)));
  await pg.click('#auto-outcomes .oc-card[data-oc="merge-pdfs"]');
  const pgCount = (n) => pg.waitForFunction((k) => document.querySelector('#pg-count').textContent.trim() === k + ' pages'
    && document.querySelectorAll('#pg-grid .rcard').length === k, n, { timeout: 15000 }).then(() => true, () => false);
  ok = await pgCount(5);
  const pgInfo = await pg.evaluate(() => ({
    hash: location.hash,
    lit: document.querySelector('#modules .slice[data-id="file"]').classList.contains('active'),
    count: document.querySelector('#pg-count').textContent.trim(),
    cards: document.querySelectorAll('#pg-grid .rcard').length,
    letters: [...document.querySelectorAll('#pg-sources .f-ico')].map((e) => e.textContent),
  }));
  check(ok && pgInfo.hash === '#file/pages' && pgInfo.lit && pgInfo.letters.join('') === 'AB',
    "Merge PDFs → #file/pages, File lit, '5 pages', 5 .rcard, sources A and B", pgInfo);
  await pg.click('#pg-grid .rcard:nth-child(1)');
  await pg.click('#pg-del');
  check(await pgCount(4), "select page 1 + Delete: '4 pages'", await pg.textContent('#pg-count'));
  await pg.click('#pg-undo');
  check(await pgCount(5), "Undo: '5 pages' again", await pg.textContent('#pg-count'));
  await pg.click('#pg-grid .rcard:nth-child(2)');
  await pg.click('#pg-rot');
  const [pgDl] = await Promise.all([pg.waitForEvent('download', { timeout: 30000 }).catch(() => null), pg.click('#pg-save')]);
  const pgBytes = pgDl ? readFileSync(await pgDl.path()) : Buffer.alloc(0);
  let pgOut = null;
  try {
    const back = await PDFLib.PDFDocument.load(pgBytes);
    pgOut = { n: back.getPageCount(), rot: back.getPages().map((p) => p.getRotation().angle), w: back.getPages().map((p) => Math.round(p.getWidth())) };
  } catch (e) { pgOut = { err: String(e) }; }
  check(!!pgDl && pgDl.suggestedFilename() === 'three.pages.pdf' && pgOut.n === 5 && pgOut.rot && pgOut.rot[1] === 90
    && pgOut.w.join(',') === '300,310,320,500,510',
    'Save PDF downloads three.pages.pdf: 5 pages in order, page 2 rotated 90', { name: pgDl && pgDl.suggestedFilename(), pgOut });
  await pg.click('#pg-split summary');
  await pg.click('#pg-export-btn');
  const [spDl] = await Promise.all([pg.waitForEvent('download', { timeout: 30000 }).catch(() => null), pg.click('#pg-export-split')]);
  const spZip = spDl ? readFileSync(await spDl.path()) : Buffer.alloc(0);
  let spEntries = 0;
  for (let i = 0; i + 4 <= spZip.length; i++) if (spZip.readUInt32LE(i) === 0x02014b50) spEntries++;
  check(!!spDl && spDl.suggestedFilename() === 'three.split.zip' && spEntries === 5,
    'Split → Every page downloads three.split.zip with 5 entries', { name: spDl && spDl.suggestedFilename(), spEntries });
  // Keyboard: with nothing selected, R rotates the focused page; Ctrl+Z undoes it.
  await pg.click('#pg-grid .rcard:nth-child(2)');
  await pg.focus('#pg-grid .rcard:nth-child(3)');
  await pg.keyboard.press('r');
  const rotKb = await pg.$eval('#pg-grid .rcard:nth-child(3) img', (i) => i.style.transform);
  await pg.keyboard.press('Control+z');
  const rotUndo = await pg.$eval('#pg-grid .rcard:nth-child(3) img', (i) => i.style.transform);
  check(/rotate\(90deg\)/.test(rotKb) && !/rotate\(90deg\)/.test(rotUndo), 'Pages keys: R rotates, Ctrl+Z undoes', { rotKb, rotUndo });
  await pg.setViewportSize({ width: 360, height: 740 });
  await pg.waitForTimeout(300);
  const pgSw = await pg.evaluate(() => ({ sw: document.documentElement.scrollWidth,
    cols: getComputedStyle(document.querySelector('#pg-grid')).gridTemplateColumns.split(' ').length }));
  check(pgSw.sw <= 360 && pgSw.cols === 2, 'Pages at 360 px: 2 columns, no horizontal page scroll', pgSw);
  await pg.setViewportSize({ width: 1280, height: 900 });
  await pg.click('#tool-pages .mode-done');
  ok = await pg.waitForFunction(() => location.hash === '#file' && document.querySelector('#tool-auto.active'), null, { timeout: 10000 }).then(() => true, () => false);
  check(ok, 'Pages: Done returns to #file', await pg.evaluate(() => location.hash));
  await pg.goto('about:blank');   // a real load, not a same-document hash change
  await pg.goto(BASE + '?lang=en#file/pages', { waitUntil: 'networkidle' });
  check(await pg.isVisible('#pg-empty') && /Put PDF pages in order/.test(await pg.textContent('#pg-empty')),
    '#file/pages by link shows the short-hero', await pg.evaluate(() => location.hash));

  // B-6: a PDF with page-level XMP, PieceInfo, an annotation author and an
  // orphan object; Clean copy for sharing rewrites it.
  const dirty = await (async () => {
    const { PDFDocument, PDFName, PDFString } = PDFLib;
    const d = await PDFDocument.create();
    d.addPage([300, 300]); d.addPage([300, 300]);
    d.setAuthor('Jane Doe');
    const ctx = d.context, p0 = d.getPage(0).node;
    p0.set(PDFName.of('Metadata'), ctx.register(ctx.stream('<x:xmpmeta>page</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' })));
    p0.set(PDFName.of('PieceInfo'), ctx.obj({ Illustrator: { Private: PDFString.of('private') } }));
    p0.set(PDFName.of('Annots'), ctx.obj([ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [1, 1, 9, 9],
      Contents: PDFString.of('note'), T: PDFString.of('Jane Doe') }))]));
    ctx.register(ctx.obj({ Orphan: PDFString.of('old revision') }));
    return Buffer.from(await d.save({ useObjectStreams: false }));
  })();
  const dirtyPath = path.join(tmp, 'dirty.pdf');
  writeFileSync(dirtyPath, dirty);
  await pg.goto(BASE + '?lang=en', { waitUntil: 'networkidle' });
  await pg.setInputFiles('#auto-input', dirtyPath);
  await pg.waitForSelector('#auto-outcomes .oc-card[data-oc="clean"]', { timeout: 15000 }).catch(() => {});
  const [clDl] = await Promise.all([pg.waitForEvent('download', { timeout: 30000 }).catch(() => null),
    pg.click('#auto-outcomes .oc-card[data-oc="clean"]')]);
  const clean = clDl ? readFileSync(await clDl.path()) : Buffer.alloc(0);
  ok = await pg.waitForFunction(() => /Page-level XMP/.test(document.querySelector('#auto-scrub').textContent), null, { timeout: 15000 }).then(() => true, () => false);
  const rep = await pg.textContent('#auto-scrub');
  check(ok && /PieceInfo/.test(rep) && /Clean copy saved · rewritten/.test(rep) && /Old revisions/.test(rep),
    "B-6: the report lists 'Page-level XMP', 'PieceInfo' and 'Old revisions' under 'Clean copy saved · rewritten'", rep);
  check(clean.length > 0 && !clean.includes('/PieceInfo') && !clean.includes('/Metadata') && !clean.includes('Jane Doe') && clean.includes('(note)'),
    'B-6: the clean copy has no /PieceInfo, no /Metadata, no author; the comment text stays', { bytes: clean.length });
  await pg.close();

  /* ── Redact (F-5, spec §12): a JPEG with GPS, one box, burned in ── */
  const rd = watch(await context.newPage(), 'redact');
  await rd.setViewportSize({ width: 1280, height: 900 });
  await rd.goto(BASE + '?lang=en', { waitUntil: 'networkidle' });
  // 200×150, large enough to drag on; the GPS APP1 from the fixture.
  const rdB64 = await rd.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 200; c.height = 150;
    const g = c.getContext('2d'); g.fillStyle = '#e0c080'; g.fillRect(0, 0, 200, 150);
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  });
  const rdPath = path.join(tmp, 'secret.jpg');
  writeFileSync(rdPath, withExifGps(Buffer.from(rdB64, 'base64')));
  await rd.setInputFiles('#auto-input', rdPath);
  await rd.waitForFunction(() => /GPS location/.test(document.querySelector('#auto-alert').textContent), null, { timeout: 15000 }).catch(() => {});
  ok = await rd.waitForSelector('#auto-outcomes .oc-card[data-oc="redact"]', { state: 'visible', timeout: 15000 }).then(() => true, () => false);
  check(ok, 'a JPEG with GPS shows a Redact card among the visible cards',
    await rd.$$eval('#auto-outcomes .oc-card', (els) => els.map((e) => e.dataset.oc + (e.offsetParent ? '' : ' (hidden)'))));
  await rd.click('#auto-outcomes .oc-card[data-oc="redact"]');
  ok = await rd.waitForFunction(() => location.hash === '#file/redact' && document.querySelector('#tool-redact.active')
    && !document.querySelector('#rd-work').classList.contains('hidden') && parseFloat(document.querySelector('#rd-canvas').style.width) > 0,
    null, { timeout: 15000 }).then(() => true, () => false);
  const rdIn = await rd.evaluate(() => ({ hash: location.hash,
    lit: document.querySelector('#modules .slice[data-id="file"]').classList.contains('active'),
    dis: document.querySelector('#rd-save').disabled, title: document.querySelector('#rd-save').title }));
  check(ok && rdIn.lit && rdIn.dis && rdIn.title === 'Draw a box first',
    "Redact card → #file/redact, File lit, 'Download redacted' disabled ('Draw a box first')", rdIn);
  const cb = await rd.locator('#rd-canvas').boundingBox();
  await rd.mouse.move(cb.x + 10, cb.y + 10);
  await rd.mouse.down();
  await rd.mouse.move(cb.x + 60, cb.y + 40, { steps: 6 });
  await rd.mouse.up();
  const rdOne = await rd.evaluate(() => ({ n: document.querySelector('#rd-count').textContent.trim(), dis: document.querySelector('#rd-save').disabled }));
  check(/^1 box$/.test(rdOne.n) && !rdOne.dis, "a drag from 10,10 to 60,40 makes 1 box and enables the primary", rdOne);
  const [rdDl] = await Promise.all([rd.waitForEvent('download', { timeout: 30000 }).catch(() => null), rd.click('#rd-save')]);
  const rdOut = rdDl ? readFileSync(await rdDl.path()) : Buffer.alloc(0);
  // The box centre (35, 25 on screen) in the output's own pixels, decoded here.
  const px = await rd.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const r = document.querySelector('#rd-canvas').getBoundingClientRect();
    const x = Math.floor(35 * bmp.width / r.width), y = Math.floor(25 * bmp.height / r.height);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    return Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
  }, rdOut.toString('base64')).catch((e) => String(e));
  check(!!rdDl && rdDl.suggestedFilename() === 'secret.redacted.jpg' && rdOut[0] === 0xFF && rdOut[1] === 0xD8
    && !exifApp1(rdOut) && !rdOut.includes('http://ns.adobe.com/xap/1.0/') && Array.isArray(px) && px.every((v) => v < 24),
    'Download redacted: a JPEG with no Exif APP1 and no XMP, black at the box centre', { name: rdDl && rdDl.suggestedFilename(), px });
  check(/Burned in 1 areas · metadata removed/.test(await rd.textContent('#rd-status')), "the status line reads 'Burned in 1 areas · metadata removed'",
    await rd.textContent('#rd-status'));
  await rd.click('#rd-undo');
  const rdUndo = await rd.evaluate(() => ({ n: document.querySelector('#rd-count').textContent.trim(), dis: document.querySelector('#rd-save').disabled }));
  check(rdUndo.n === '0 boxes' && rdUndo.dis, 'Undo leaves 0 boxes and disables the primary', rdUndo);
  // Find text is only looked at: pressing it would load Tesseract.
  check(!!(await rd.$('#rd-q')) && !vendorReqs('redact').some((u) => u.startsWith('vendor/tesseract') || u.startsWith('vendor/tessdata')),
    'Redact: the Find text input exists, and nothing loaded Tesseract', vendorReqs('redact'));
  await rd.goto('about:blank');   // a real load, not a same-document hash change
  await rd.goto(BASE + '?lang=en#file/redact', { waitUntil: 'networkidle' });
  check(await rd.isVisible('#rd-empty') && /Drop an image to redact/.test(await rd.textContent('#rd-empty')),
    '#file/redact by link shows the short-hero', await rd.evaluate(() => location.hash));
  await rd.close();

  /* ── Bridge receive (F-7): a same-origin sender hands a PEM to #metadata ── */
  const bs = watch(await context.newPage(), 'bridge-send');
  await bs.goto(BASE + '?lang=en', { waitUntil: 'networkidle' });
  const [bridged, sent] = await Promise.all([
    context.waitForEvent('page', { timeout: 15000 }).catch(() => null),
    bs.evaluate(async (pem) => {
      const f = new File([pem], 'handed.pem', { type: 'application/x-pem-file' });
      try { return await CarinoBridge.send(location.origin + '/?lang=en#metadata', [f], { timeout: 20000 }); }
      catch (e) { return { err: String(e) }; }
    }, CERT_PEM.p384),
  ]);
  if (bridged) watch(bridged, 'bridge-recv');
  ok = !!bridged && await bridged.waitForFunction(() => document.querySelector('#tool-metadata.active')
    && /ECDSA P-384/.test(document.querySelector('#md-groups').textContent)
    && !/carino-bridge/.test(location.href), null, { timeout: 15000 }).then(() => true, () => false);
  check(ok && sent && sent.acknowledged === true && sent.count === 1,
    'Bridge: a same-origin sender at #metadata&carino-bridge lands the file in the metadata workspace, acknowledged, marker dropped',
    { sent, url: bridged && bridged.url() });
  if (bridged) await bridged.close();
  await bs.close();

  check(errors.length === 0, 'no console errors on any page', errors);
  await context.close();

  /* ── P9 · the offline service worker (O-4), in a fresh context ── */
  const swCtx = await browser.newContext();
  try {
    const sw = watch(await swCtx.newPage(), 'sw');
    await sw.setViewportSize({ width: 1280, height: 900 });
    await sw.goto(BASE + '?lang=en', { waitUntil: 'networkidle' });
    const swIn = await sw.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return { ready: false };
      const ready = await Promise.race([navigator.serviceWorker.ready.then(() => true),
        new Promise((r) => setTimeout(() => r(false), 10000))]);
      // activate claims this page; pdf.js below must go through the worker.
      for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i++) await new Promise((r) => setTimeout(r, 100));
      const keys = await caches.keys();
      const shell = keys.find((k) => k.startsWith('files-shell-'));
      const entries = shell ? (await (await caches.open(shell)).keys()).map((r) => new URL(r.url).pathname) : [];
      return { ready, keys, n: entries.length, vendor: entries.filter((p) => p.includes('/vendor/')) };
    });
    check(swIn.ready && swIn.keys.some((k) => k.startsWith('files-shell-')),
      'service worker ready within 10 s, with a files-shell- cache', swIn.keys);
    check(swIn.n > 10 && swIn.vendor.length === 0, 'the shell cache holds no vendor/ entry', { n: swIn.n, vendor: swIn.vendor });
    check(/Works offline/.test(await sw.evaluate(() => (document.querySelector('[data-carino-about]') || {}).textContent || '')),
      "the About popup says 'Works offline after your first visit.'");

    // A PDF online: pdf.js lands in the vendor runtime cache.
    const pdfShown = () => sw.waitForFunction(() => !document.querySelector('#auto-preview').classList.contains('hidden')
      && /^blob:/.test(document.querySelector('#auto-thumb').src || ''), null, { timeout: 20000 }).then(() => true, () => false);
    await sw.setInputFiles('#auto-input', p3);
    ok = await pdfShown();
    const vendorCached = await sw.waitForFunction(async () => {
      const k = (await caches.keys()).find((x) => x.startsWith('files-vendor-'));
      if (!k) return false;
      const urls = (await (await caches.open(k)).keys()).map((r) => r.url);
      return urls.some((u) => u.endsWith('/vendor/pdfjs/pdf.min.mjs')) && urls.some((u) => u.endsWith('/vendor/pdfjs/pdf.worker.min.mjs'));
    }, null, { timeout: 15000, polling: 250 }).then(() => true, () => false);
    check(ok && vendorCached, 'a PDF online renders page 1 and puts pdf.js in the files-vendor- cache');

    // Offline: the page and the same PDF still work.
    await swCtx.setOffline(true);
    await sw.reload({ waitUntil: 'load' });
    const offSlices = await sw.waitForFunction(() => document.querySelectorAll('#modules .slice').length === 5, null, { timeout: 15000 })
      .then(() => true, () => false);
    check(offSlices, 'offline: a reload still renders #modules with 5 slices',
      await sw.evaluate(() => document.querySelectorAll('#modules .slice').length).catch((e) => String(e)));
    await sw.setInputFiles('#auto-input', p3);
    check(await pdfShown(), 'offline: the same PDF still renders page 1 (pdf.js from the runtime cache)');
    await swCtx.setOffline(false);
    await sw.close();
  } finally {
    await swCtx.setOffline(false).catch(() => {});
    await swCtx.close();
  }
} catch (e) {
  fail++;
  console.log('FAIL smoke run threw: ' + (e && e.stack || e));
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log('---');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
