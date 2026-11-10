// js/lib/printpages.js: where the report preview draws its page ends, and the
// preview's wiring in index.html, js/report-preview.js and js/ws/metadata.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, need, read } from './load.mjs';

const H = 100;
const box = (t, b, extra = {}) => ({ t, b, avoid: false, kids: [], ...extra });
const breaks = (blocks, h = H) => Array.from(lib.printPageBreaks(blocks, h));

test('a report shorter than a page has no break', need('printPageBreaks'), () => {
  assert.deepEqual(breaks([box(0, 40), box(40, 99)]), []);
  assert.deepEqual(breaks([]), []);
  assert.deepEqual(breaks(null), []);
});

test('an avoid box that crosses the end moves whole to the next page', need('printPageBreaks'), () => {
  assert.deepEqual(breaks([box(0, 60), box(60, 130, { avoid: true }), box(130, 155)]), [60]);
  // ...and the next page is measured from its top
  assert.deepEqual(breaks([box(0, 60), box(60, 130, { avoid: true }), box(130, 175, { avoid: true })]), [60, 130]);
});

test('an avoid box taller than a page breaks between its rows', need('printPageBreaks'), () => {
  const rows = [];
  for (let y = 10; y < 250; y += 20) rows.push(box(y, y + 20, { avoid: true }));
  const section = box(10, 250, { avoid: true, kids: rows });
  assert.deepEqual(breaks([box(0, 10), section]), [90, 190]);
});

test('a plain box with no children breaks at the page end', need('printPageBreaks'), () => {
  assert.deepEqual(breaks([box(0, 250)]), [100, 200]);
  assert.deepEqual(breaks([box(0, 50), box(50, 120)]), [100]);
});

test('an avoid box taller than a page, with no rows, breaks at the page end', need('printPageBreaks'), () => {
  assert.deepEqual(breaks([box(0, 150, { avoid: true })]), [100]);
});

test('no page height, no breaks', need('printPageBreaks'), () => {
  assert.deepEqual(breaks([box(0, 500)], 0), []);
});

test('Printable report opens the preview, and only its Print prints', () => {
  const html = read('index.html');
  assert.match(html, /id="rp-scrim"[^>]*hidden/);
  assert.match(html, /id="rp-frame"/);
  assert.match(html, /id="rp-print"[^>]*disabled/);
  assert.match(html, /id="md-print"[^>]*data-act="print"/);
  const md = read('js/ws/metadata.js');
  assert.match(md, /openReportPreview\(\{/);
  assert.doesNotMatch(md, /\.print\(\)/, 'metadata.js must not print without the preview');
  const rp = read('js/report-preview.js');
  assert.match(rp, /frame\.srcdoc = rpPreviewHtml\(html\)/);
  assert.match(rp, /contentWindow\.print\(\)/);
  // The preview's sheet, page lines and grey are screen only: the frame prints the report as built.
  assert.match(rp, /@media screen \{/);
  assert.match(rp, /@media print \{ \.rp-break\{display:none/);
  // The fleet's shared layout (carino-ui.css 18b): every control in the left
  // column, Print at its foot, no footer bar or second Close button.
  assert.match(html, /id="rp-scrim" hidden/);
  assert.match(html, /class="modal-scrim rpv-scrim" id="rp-scrim"/);
  const at = html.indexOf('<aside class="rpv-side">');
  const side = html.slice(at, html.indexOf('</aside>', at));
  for (const id of ['rp-title', 'rp-x', 'rp-status', 'rp-name', 'rp-print']) assert.match(side, new RegExp('id="' + id + '"'), id + ' sits in the left column');
  assert.match(side, /<div class="rpv-actions">[\s\S]*id="rp-print"/);
  const dlg = html.slice(html.indexOf('id="rp-scrim"'), html.indexOf('</div>\n</div>', html.indexOf('id="rp-scrim"')));
  assert.doesNotMatch(dlg, /modal-foot|rp-foot/);
  assert.equal((dlg.match(/data-close/g) || []).length, 1, 'the only Close is the ✕');
  assert.match(html, /<div class="rpv-stage" id="rp-stage"><iframe id="rp-frame" class="rpv-frame"/);
  // No local copy of the old dialog's layout.
  assert.doesNotMatch(read('css/files.css'), /\.rp-(box|foot|stage|frame|name)\b/);
});
