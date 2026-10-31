// js/lib/pageops.js: the Pages mode edit list (ops, undo, plans, split) and
// its pdf-lib build, plus the PDF clean-copy rewrite in js/lib/scrub.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, need } from './load.mjs';
import { PDFLib, needPdfLib } from './pdflib.mjs';

const two = () => {
  let s = lib.pagesInit();
  s = lib.pagesApply(s, { type: 'add-source', id: 'x', name: 'a.pdf', pageCount: 3 });
  s = lib.pagesApply(s, { type: 'add-source', id: 'y', name: 'b.pdf', pageCount: 2 });
  return s;
};
const ids = (s) => s.pages.map((p) => p.src + p.index);

test('add-source appends pages and letters the sources A, B…', need('pagesInit', 'pagesApply'), () => {
  const s = two();
  assert.deepEqual(s.sources.map((x) => x.letter), ['A', 'B']);
  assert.deepEqual(s.sources.map((x) => x.pageCount), [3, 2]);
  assert.deepEqual(ids(s), ['x0', 'x1', 'x2', 'y0', 'y1']);
  assert.ok(s.pages.every((p) => p.rotate === 0));
  assert.equal(s.history.length, 2);
  // The same id twice changes nothing.
  assert.equal(lib.pagesApply(s, { type: 'add-source', id: 'x', pageCount: 9 }), s);
});

test('a removed source frees its letter for the next one', need('pagesApply'), () => {
  let s = lib.pagesApply(two(), { type: 'remove-source', id: 'x' });
  assert.deepEqual(ids(s), ['y0', 'y1']);
  assert.deepEqual(s.sources.map((x) => x.letter), ['B']);
  s = lib.pagesApply(s, { type: 'add-source', id: 'z', pageCount: 1 });
  assert.deepEqual(s.sources.map((x) => x.letter), ['B', 'A']);
  assert.equal(lib.pagesApply(s, { type: 'remove-source', id: 'nope' }), s);
});

test('move re-inserts the pages, in the order given, at the target', need('pagesApply'), () => {
  const s = two();
  assert.deepEqual(ids(lib.pagesApply(s, { type: 'move', indices: [3], to: 0 })), ['y0', 'x0', 'x1', 'x2', 'y1']);
  assert.deepEqual(ids(lib.pagesApply(s, { type: 'move', indices: [0, 2], to: 3 })), ['x1', 'y0', 'y1', 'x0', 'x2']);
  assert.deepEqual(ids(lib.pagesApply(s, { type: 'move', indices: [4, 1], to: 0 })), ['y1', 'x1', 'x0', 'x2', 'y0']);
  // Clamped; a move that changes nothing is no step.
  assert.deepEqual(ids(lib.pagesApply(s, { type: 'move', indices: [0], to: 99 })), ['x1', 'x2', 'y0', 'y1', 'x0']);
  assert.equal(lib.pagesApply(s, { type: 'move', indices: [0], to: 0 }), s);
  assert.equal(lib.pagesApply(s, { type: 'move', indices: [], to: 2 }), s);
});

test('rotate turns by ±90 and keeps 0/90/180/270', need('pagesApply'), () => {
  let s = lib.pagesApply(two(), { type: 'rotate', indices: [1, 2], by: 90 });
  assert.deepEqual(s.pages.map((p) => p.rotate), [0, 90, 90, 0, 0]);
  s = lib.pagesApply(s, { type: 'rotate', indices: [1], by: -90 });
  s = lib.pagesApply(s, { type: 'rotate', indices: [0], by: -90 });
  assert.deepEqual(s.pages.map((p) => p.rotate), [270, 0, 90, 0, 0]);
  s = lib.pagesApply(s, { type: 'rotate', indices: [2], by: 270 });
  assert.equal(s.pages[2].rotate, 0);
  assert.equal(lib.pagesApply(s, { type: 'rotate', indices: [0], by: 45 }), s);
});

test('delete drops the pages; undo walks back each step', need('pagesApply', 'pagesUndo'), () => {
  const s0 = two();
  const s1 = lib.pagesApply(s0, { type: 'delete', indices: [0, 4, 99] });
  assert.deepEqual(ids(s1), ['x1', 'x2', 'y0']);
  const s2 = lib.pagesApply(s1, { type: 'rotate', indices: [0], by: 90 });
  const u1 = lib.pagesUndo(s2);
  assert.deepEqual(u1.pages, s1.pages);
  assert.equal(u1.history.length, s1.history.length);
  const u2 = lib.pagesUndo(u1);
  assert.deepEqual(ids(u2), ids(s0));
  // Undo through the add-sources back to empty, then no further.
  const e = lib.pagesUndo(lib.pagesUndo(u2));
  assert.equal(e.pages.length, 0);
  assert.equal(e.sources.length, 0);
  assert.equal(lib.pagesUndo(e), e);
});

test('pagesPlan: every page, or chosen positions in document order', need('pagesPlan', 'pagesApply'), () => {
  const s = lib.pagesApply(two(), { type: 'rotate', indices: [3], by: 90 });
  assert.equal(lib.pagesPlan(s).length, 5);
  assert.deepEqual(lib.pagesPlan(s, [3, 0]), [{ src: 'x', index: 0, rotate: 0 }, { src: 'y', index: 0, rotate: 90 }]);
});

test('splitPlan: every page, and one group per comma-separated range', need('splitPlan'), () => {
  const s = two();
  const every = lib.splitPlan(s, 'every', '');
  assert.equal(every.length, 5);
  assert.deepEqual(every.map((g) => g.label), ['1', '2', '3', '4', '5']);
  assert.deepEqual(lib.splitPlan(s, 'every', '2-3').map((g) => g.plan[0].src + g.plan[0].index), ['x1', 'x2']);
  const r = lib.splitPlan(s, 'ranges', '1, 3-5, 9');
  assert.deepEqual(r.map((g) => g.label), ['1', '3-5']);
  assert.deepEqual(r[1].plan.map((p) => p.src + p.index), ['x2', 'y0', 'y1']);
  const all = lib.splitPlan(s, 'ranges', '  ');
  assert.equal(all.length, 1);
  assert.equal(all[0].plan.length, 5);
  assert.deepEqual(lib.splitPlan(lib.pagesInit(), 'every', ''), []);
});

/* ── pdf-lib: the build and the clean-copy rewrite ── */
async function makePdf(n, opts = {}) {
  const { PDFDocument, PDFName, PDFString } = PDFLib;
  const d = await PDFDocument.create();
  for (let i = 0; i < n; i++) d.addPage([200 + i * 10, 300]);
  d.setTitle('Secret title');
  d.setAuthor('Jane Doe');
  if (opts.junk) {
    const ctx = d.context;
    const xmp = ctx.stream('<x:xmpmeta>page xmp</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' });
    d.catalog.set(PDFName.of('Metadata'), ctx.register(ctx.stream('<x:xmpmeta>doc</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' })));
    const p0 = d.getPage(0).node;
    p0.set(PDFName.of('Metadata'), ctx.register(xmp));
    p0.set(PDFName.of('PieceInfo'), ctx.obj({ Illustrator: { Private: PDFString.of('ai private') } }));
    const annot = ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 30, 30], Contents: PDFString.of('note'),
      T: PDFString.of('Jane Doe'), M: PDFString.of('D:20240101000000Z'), P: d.getPage(0).ref });
    p0.set(PDFName.of('Annots'), ctx.obj([ctx.register(annot)]));
    ctx.register(ctx.obj({ Orphan: PDFString.of('left over from an old save') }));
  }
  return d.save({ useObjectStreams: false });
}

test('pagesBuildPdf: merge, order and rotation', { ...need('pagesBuildPdf', 'pagesApply'), ...needPdfLib() }, async () => {
  const { PDFDocument } = PDFLib;
  const a = await PDFDocument.load(await makePdf(3));
  const b = await PDFDocument.load(await makePdf(2));
  let s = two();
  s = lib.pagesApply(s, { type: 'rotate', indices: [1], by: 90 });
  s = lib.pagesApply(s, { type: 'move', indices: [4], to: 0 });
  s = lib.pagesApply(s, { type: 'delete', indices: [3] });   // [y1, x0, x1↻, y0]
  const out = await lib.pagesBuildPdf(PDFLib, { x: a, y: b }, lib.pagesPlan(s));
  const back = await PDFDocument.load(await out.save());
  assert.equal(back.getPageCount(), 4);
  assert.deepEqual(back.getPages().map((p) => Math.round(p.getWidth())), [210, 200, 210, 200]);
  assert.deepEqual(back.getPages().map((p) => p.getRotation().angle), [0, 0, 90, 0]);
});

test('pdfRewriteClean drops page XMP, PieceInfo, authors, old objects; keeps the pages', { ...need('pdfRewriteClean', 'pdfScrubReport'), ...needPdfLib() }, async () => {
  const src = await makePdf(2, { junk: true });
  const has = (b, s) => Buffer.from(b).includes(s);
  assert.ok(has(src, '/PieceInfo') && has(src, 'Jane Doe') && has(src, 'old save'));
  const r = await lib.pdfRewriteClean(PDFLib, src);
  assert.equal(r.counts.pageXmp, 1);
  assert.equal(r.counts.pieceInfo, 1);
  assert.equal(r.counts.annotAuthors, 1);
  assert.ok(r.counts.xmp);
  assert.ok(r.counts.info >= 2);
  assert.ok(r.counts.unused >= 1, 'the orphan counts as an old revision object');
  for (const s of ['/PieceInfo', '/Metadata', 'Jane Doe', 'Secret title', 'old save', 'page xmp', '/Info', '/ID'])
    assert.ok(!has(r.bytes, s), 'no ' + s + ' in the copy');
  assert.ok(has(r.bytes, '(note)'), 'the comment text stays');
  const back = await PDFLib.PDFDocument.load(r.bytes);
  assert.equal(back.getPageCount(), 2);
  assert.equal(back.getTitle(), undefined);
  const keys = lib.pdfScrubReport(r.counts).map((x) => x.key);
  assert.deepEqual(keys, ['Document info ({n} fields)', 'Document XMP', 'Page-level XMP ({n} pages)',
    'PieceInfo ({n} pages)', 'Annotation authors ({n})', 'Annotation dates ({n})', 'Old revisions ({n} unused objects)']);
  assert.ok(r.notes.some((n) => /Comment text/.test(n)));
});

test('pdfRewriteClean keeps a form working', { ...need('pdfRewriteClean'), ...needPdfLib() }, async () => {
  const { PDFDocument } = PDFLib;
  const d = await PDFDocument.create();
  const page = d.addPage([300, 300]);
  const f = d.getForm().createTextField('client.name');
  f.setText('Ada');
  f.addToPage(page, { x: 10, y: 10, width: 200, height: 20 });
  const r = await lib.pdfRewriteClean(PDFLib, await d.save());
  const back = await PDFDocument.load(r.bytes);
  const fields = back.getForm().getFields();
  assert.deepEqual(fields.map((x) => x.getName()), ['client.name']);
  assert.equal(back.getForm().getTextField('client.name').getText(), 'Ada');
  assert.equal(r.counts.annotAuthors, 0, 'a widget /T is the field name, not an author');
});

test('pdfRewriteClean: a widget date is a date, not an author', { ...need('pdfRewriteClean', 'pdfScrubReport'), ...needPdfLib() }, async () => {
  const { PDFDocument, PDFName, PDFString } = PDFLib;
  const d = await PDFDocument.create();
  const page = d.addPage([300, 300]);
  const f = d.getForm().createTextField('client.name');
  f.addToPage(page, { x: 10, y: 10, width: 200, height: 20 });
  f.acroField.getWidgets()[0].dict.set(PDFName.of('M'), PDFString.of('D:20240101000000Z'));
  const r = await lib.pdfRewriteClean(PDFLib, await d.save());
  assert.equal(r.counts.annotAuthors, 0);
  assert.equal(r.counts.annotDates, 1);
  const keys = lib.pdfScrubReport(r.counts).map((x) => x.key);
  assert.ok(keys.includes('Annotation dates ({n})'));
  assert.ok(!keys.includes('Annotation authors ({n})'));
});

test('pdfRewriteClean strips XObject XMP/PieceInfo and JPEG EXIF inside image streams', { ...need('pdfRewriteClean', 'pdfScrubReport'), ...needPdfLib() }, async () => {
  const { PDFDocument, PDFName, PDFString, PDFRawStream } = PDFLib;
  const { jpeg } = await import('./fixtures.mjs');
  const d = await PDFDocument.create();
  const page = d.addPage([300, 300]);
  const ctx = d.context;
  const xmp = ctx.register(ctx.stream('<x:xmpmeta>SECRET-AUTHOR-XMP</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' }));
  const form = ctx.stream('q Q', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10],
    PieceInfo: { Illustrator: { Private: PDFString.of('ai-private-secret') } } });
  form.dict.set(PDFName.of('Metadata'), xmp);
  const jp = jpeg();
  const img = PDFRawStream.of(ctx.obj({ Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1,
    ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode', Length: jp.length }), jp);
  page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Fm1: ctx.register(form), Im1: ctx.register(img) } }));
  const src = await d.save({ useObjectStreams: false });
  const has = (b, s) => Buffer.from(b).includes(s);
  assert.ok(has(src, 'SECRET-AUTHOR-XMP') && has(src, 'Exif'));
  const r = await lib.pdfRewriteClean(PDFLib, src);
  for (const s of ['SECRET-AUTHOR-XMP', 'ai-private-secret', '/PieceInfo', '/Metadata', 'Exif', 'secret'])
    assert.ok(!has(r.bytes, s), 'no ' + s + ' in the copy');
  assert.equal(r.counts.objMeta, 2);
  assert.equal(r.counts.unused, 0);
  assert.ok(lib.pdfScrubReport(r.counts).some((x) => x.key === 'Embedded object metadata ({n})'));
  const back = await PDFDocument.load(r.bytes);
  assert.equal(back.getPageCount(), 1);
});

test('pdfRewriteClean: Fast Web View data is not counted as old revisions', { ...need('pdfRewriteClean'), ...needPdfLib() }, async () => {
  const { PDFDocument } = PDFLib;
  const d = await PDFDocument.create();
  d.addPage([300, 300]);
  const ctx = d.context;
  ctx.register(ctx.obj({ Linearized: 1, L: 1000, H: [500, 60], O: 3, E: 900, N: 1, T: 950 }));
  ctx.register(ctx.stream('hint-table', { S: 36 }));
  let r = await lib.pdfRewriteClean(PDFLib, await d.save({ useObjectStreams: false }));
  assert.equal(r.counts.unused, 0);
  // A real leftover object still counts next to them.
  ctx.register(ctx.obj({ Orphan: 1 }));
  r = await lib.pdfRewriteClean(PDFLib, await d.save({ useObjectStreams: false }));
  assert.equal(r.counts.unused, 1);
});

test('pdfScrubReport and scrubTruncate', need('pdfScrubReport', 'scrubTruncate'), () => {
  assert.deepEqual(lib.pdfScrubReport({}), []);
  assert.deepEqual(lib.pdfScrubReport({ info: 3, unused: -2, appData: true }), [
    { key: 'Document info ({n} fields)', vars: { n: 3 } },
    { key: 'Application private data', vars: null },
  ]);
  const list = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.deepEqual(lib.scrubTruncate(list.slice(0, 6)), { shown: [1, 2, 3, 4, 5, 6], more: 0 });
  assert.deepEqual(lib.scrubTruncate(list), { shown: [1, 2, 3, 4, 5, 6], more: 2 });
  assert.deepEqual(lib.scrubTruncate(list, 6, true), { shown: list, more: 0 });
  assert.deepEqual(lib.scrubTruncate(list, 3), { shown: [1, 2, 3], more: 5 });
  assert.deepEqual(lib.scrubTruncate(null), { shown: [], more: 0 });
});
