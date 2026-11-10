// The report preview's file: File PDF | HTML (carino-pdf.js) above the name,
// Print then Download at the foot, and Download saving the report's own HTML
// (never the preview's screen-only sheet) as the chosen format, with the busy
// and failure states in the status line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { read } from './load.mjs';

test('markup: Print then one primary Download at the foot; carino-pdf.js is loaded deferred', () => {
  const html = read('index.html');
  const at = html.indexOf('<aside class="rpv-side">', html.indexOf('id="rp-scrim"'));
  const side = html.slice(at, html.indexOf('</aside>', at));
  const foot = side.slice(side.indexOf('<div class="rpv-actions">'));
  const buttons = [...foot.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(buttons.length, 2, 'Print and Download only');
  assert.match(buttons[0], /id="rp-print"/);
  assert.doesNotMatch(buttons[0], /btn-primary/);
  assert.match(buttons[1], /id="rp-download"[^>]*disabled|disabled[^>]*id="rp-download"/);
  assert.match(buttons[1], /class="btn btn-primary"/);
  // the name sits just above the foot, so the switch put in before it is too
  assert.ok(side.indexOf('id="rp-name"') < side.indexOf('rpv-actions'));
  assert.ok(side.indexOf('id="rp-status"') < side.indexOf('id="rp-name"'));
  assert.match(html, /<script src="carino-pdf\.js" defer><\/script>/);
});

// A small stand-in for the page: the elements report-preview.js touches, the
// core.js label helpers, and a CarinoPdf whose download is recorded.
function page({ fail = false } = {}) {
  const els = {};
  const el = (id) => els[id] || (els[id] = {
    id, textContent: '', disabled: false, dataset: {}, style: {}, children: [],
    parentNode: { insertBefore(n, ref) { (els.__inserted = els.__inserted || []).push([n, ref.id]); } },
    addEventListener() {}, removeAttribute() {},
  });
  const calls = [];
  const fmtT = (k, v) => (v ? k.replace(/\{(\w+)\}/g, (m, n) => v[n]) : k);
  let release;
  const CarinoPdf = {
    t: null,
    formatSwitch(cfg) {
      let v = 'pdf';
      return { el: { id: 'switch' }, get: () => v, set: (x) => { v = x; cfg.onChange(x); }, relabel() {} };
    },
    fileName: (n, f) => n + (f === 'html' ? '.html' : '.pdf'),
    label: (f) => (f === 'html' ? 'Download HTML' : 'Download PDF'),
    download(cfg) {
      calls.push(cfg);
      return new Promise((res) => { release = () => res(fail ? { ok: false, error: 'x' } : { ok: true, name: cfg.name }); });
    },
  };
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, Promise,
    document: { getElementById: el },
    window: { addEventListener() {}, CarinoPdf },
    CarinoPdf,
    T: (s) => s,
    fmtT,
    setText(e, k, v) { if (e) { e.dataset.tk = k; e.textContent = k ? fmtT(k, v) : ''; } return e; },
    setRaw(e, s) { if (e) { delete e.dataset.tk; e.textContent = s == null ? '' : String(s); } return e; },
    toast() {},
    printPageBreaks: () => [],
    CarinoUI: { modal: { open() {}, close() {}, isOpen: () => true } },
  });
  vm.runInContext(read('js/report-preview.js'), ctx, { filename: 'report-preview.js' });
  return { ctx, els, calls, release: () => release(), run: (code) => vm.runInContext(code, ctx) };
}

test('the switch goes in above the name; the name and Download follow it', () => {
  const p = page();
  p.run(`_rp.cfg = { name: 'photo.jpg', file: 'photo-metadata', build: () => '' }; rpFormatSwitch(); rpLabelFile();`);
  assert.deepEqual(p.els.__inserted.map(([n, ref]) => [n.id, ref]), [['switch', 'rp-name']]);
  assert.equal(p.els['rp-name'].textContent, 'photo-metadata.pdf');
  assert.equal(p.els['rp-download'].textContent, 'Download PDF');
  p.run(`_rp.format.set('html')`);
  assert.equal(p.els['rp-name'].textContent, 'photo-metadata.html');
  assert.equal(p.els['rp-download'].textContent, 'Download HTML');
  assert.equal(p.ctx.CarinoPdf.t, p.ctx.T, 'the PDF strings use the page translator');
});

test('Download saves the report as built, busy while the PDF is made, then the page count again', async () => {
  const p = page();
  p.run(`_rp.cfg = { name: 'a.png', file: 'a-metadata' }; rpFormatSwitch();
         _rp.html = '<!DOCTYPE html><html><body>report</body></html>'; _rp.ready = true; _rp.pages = 2;`);
  const done = p.run('rpDownload()');
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].html, '<!DOCTYPE html><html><body>report</body></html>');
  assert.equal(p.calls[0].name, 'a-metadata');
  assert.equal(p.calls[0].format, 'pdf');
  assert.equal(p.els['rp-download'].disabled, true);
  assert.equal(p.els['rp-status'].textContent, 'Creating the PDF…');
  p.run('rpDownload()');
  assert.equal(p.calls.length, 1, 'a second click while busy does nothing');
  p.release();
  await done;
  assert.equal(p.els['rp-download'].disabled, false);
  assert.equal(p.els['rp-status'].textContent, 'About 2 pages on A4');
});

test('a failed PDF says so in the status; HTML makes no busy message', async () => {
  const p = page({ fail: true });
  p.run(`_rp.cfg = { name: 'a.png' }; rpFormatSwitch(); _rp.html = '<p>r</p>'; _rp.ready = true; _rp.pages = 1;`);
  let done = p.run('rpDownload()');
  p.release();
  await done;
  assert.equal(p.els['rp-status'].textContent, 'Could not create the PDF.');
  assert.equal(p.els['rp-download'].disabled, false);
  p.run(`_rp.format.set('html')`);
  p.els['rp-status'].textContent = 'About 1 page on A4';
  done = p.run('rpDownload()');
  assert.equal(p.calls[1].format, 'html');
  assert.equal(p.calls[1].name, 'a.png', 'no file stem: the name');
  assert.equal(p.els['rp-status'].textContent, 'About 1 page on A4');
  p.release();
  await done;
  assert.equal(p.els['rp-status'].textContent, 'Could not create the HTML file.');
});

test('nothing is downloaded before the report is ready', () => {
  const p = page();
  p.run(`_rp.cfg = { name: 'a.png' }; _rp.html = '<p>r</p>'; _rp.ready = false;`);
  p.run('rpDownload()');
  assert.equal(p.calls.length, 0);
});
