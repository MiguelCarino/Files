'use strict';
/* ─── PDF pages: the edit list behind Pages mode (spec §10.3) ───
   DOM-free, so node tests can load it (tests/pageops.test.mjs). Nothing is
   written until an output is asked for: the mode only edits this state.

   state = { sources: [{ id, letter, name, pageCount }],
             pages:   [{ src, index, rotate }],     index: 0-based in its source
             history: [{ op, prev: { sources, pages } }] }

   pagesInit()              an empty state
   pagesApply(state, op)    a new state, op pushed to history; the same state
                            back when op changes nothing (no undo step)
   pagesUndo(state)         the state before the last op (same state if none)
   pagesPlan(state, idx?)   [{ src, index, rotate }] of every page, or of the
                            positions idx (in document order)
   splitPlan(state, mode, rangeText)
                            [{ label, plan }], one output file each.
                            'every':  one per page in the range (empty = all)
                            'ranges': one per comma-separated range, read with
                                      parsePageRange (empty = all, one file)
                            Page numbers are the current 1-based positions.

   ops: { type: 'add-source', id, name, pageCount }   pages appended, letter A, B…
        { type: 'remove-source', id }                 the source and its pages
        { type: 'move', indices, to }                 the pages at indices, in
             the order given, re-inserted at `to`, an index into the list with
             those pages taken out (0 = first, its length = last)
        { type: 'rotate', indices, by }               by ±90; 0/90/180/270
        { type: 'delete', indices }

   The pdf-lib side (pdfCopyPagesSeeded, pagesBuildPdf) takes the PDFLib
   namespace as an argument, so it runs on the page and under node alike. */

function pagesInit(){ return { sources: [], pages: [], history: [] }; }

// A, B … Z, AA, AB …: the first letter no current source holds.
function _pagesLetter(n){
  let s = '';
  n += 1;
  while(n > 0){ const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
const _pagesIdx = (state, indices) => Array.from(new Set((indices || [])
  .map(Number).filter(i => Number.isInteger(i) && i >= 0 && i < state.pages.length)));

function pagesApply(state, op){
  if(!state || !op) return state;
  let sources = state.sources, pages = state.pages;
  switch(op.type){
    case 'add-source': {
      const n = Math.max(0, op.pageCount | 0);
      if(op.id == null || sources.some(s => s.id === op.id)) return state;
      const used = new Set(sources.map(s => s.letter));
      let i = 0;
      while(used.has(_pagesLetter(i))) i++;
      sources = sources.concat([{ id: op.id, letter: _pagesLetter(i), name: String(op.name || ''), pageCount: n }]);
      pages = pages.concat(Array.from({ length: n }, (_, k) => ({ src: op.id, index: k, rotate: 0 })));
      break;
    }
    case 'remove-source': {
      if(!sources.some(s => s.id === op.id)) return state;
      sources = sources.filter(s => s.id !== op.id);
      pages = pages.filter(p => p.src !== op.id);
      break;
    }
    case 'move': {
      const idx = _pagesIdx(state, op.indices);
      if(!idx.length) return state;
      const moving = idx.map(i => pages[i]);
      const rest = pages.filter((_, i) => !idx.includes(i));
      const to = Math.max(0, Math.min(rest.length, Number(op.to) | 0));
      const next = rest.slice(0, to).concat(moving, rest.slice(to));
      if(next.every((p, i) => p === pages[i])) return state;
      pages = next;
      break;
    }
    case 'rotate': {
      const idx = _pagesIdx(state, op.indices);
      const by = Number(op.by) || 0;
      if(!idx.length || by % 90 !== 0 || by % 360 === 0) return state;
      pages = pages.map((p, i) => idx.includes(i) ? Object.assign({}, p, { rotate: (((p.rotate + by) % 360) + 360) % 360 }) : p);
      break;
    }
    case 'delete': {
      const idx = _pagesIdx(state, op.indices);
      if(!idx.length) return state;
      pages = pages.filter((_, i) => !idx.includes(i));
      break;
    }
    default: return state;
  }
  return { sources, pages, history: state.history.concat([{ op, prev: { sources: state.sources, pages: state.pages } }]) };
}

function pagesUndo(state){
  if(!state || !state.history.length) return state;
  const last = state.history[state.history.length - 1];
  return { sources: last.prev.sources, pages: last.prev.pages, history: state.history.slice(0, -1) };
}

function pagesPlan(state, indices){
  const list = indices == null ? state.pages.map((_, i) => i) : _pagesIdx(state, indices).sort((a, b) => a - b);
  return list.map(i => ({ src: state.pages[i].src, index: state.pages[i].index, rotate: state.pages[i].rotate }));
}

function splitPlan(state, mode, rangeText){
  const n = state.pages.length;
  if(!n) return [];
  const text = String(rangeText || '');
  const label = (nums) => nums.length > 1 && nums[nums.length - 1] - nums[0] === nums.length - 1
    ? nums[0] + '-' + nums[nums.length - 1] : nums.join('_');
  if(mode === 'ranges'){
    const chunks = text.trim() ? text.split(',').map(c => c.trim()).filter(Boolean) : [''];
    return chunks.map(c => parsePageRange(c, n)).filter(nums => nums.length)
      .map(nums => ({ label: label(nums), plan: pagesPlan(state, nums.map(x => x - 1)) }));
  }
  return parsePageRange(text, n).map(x => ({ label: String(x), plan: pagesPlan(state, [x - 1]) }));
}

/* Copies pages of src into out with one PDFObjectCopier, after telling it
   where every source page goes: a page copied here maps to its new ref, a
   page left out maps to null. An annotation's /P, a link's destination or a
   form field that points at a page then lands on the copy (or on nothing),
   instead of dragging the whole source page tree in with it, which is what
   PDFDocument.copyPages does. indices: 0-based, each once.
   → { pages: [PDFPage] in the order of indices (not yet added), copier }. */
function pdfCopyPagesSeeded(PDFLib, out, src, indices){
  const { PDFObjectCopier, PDFPage, PDFNull } = PDFLib;
  const copier = PDFObjectCopier.for(src.context, out.context);
  const srcPages = src.getPages();
  const want = new Map();
  indices.forEach(i => { if(srcPages[i] && !want.has(i)) want.set(i, out.context.nextRef()); });
  srcPages.forEach((p, i) => copier.traversedObjects.set(p.ref, want.has(i) ? want.get(i) : PDFNull));
  const pages = indices.map(i => {
    const ref = want.get(i);
    const node = copier.copy(srcPages[i].node);
    out.context.assign(ref, node);
    return PDFPage.of(node, ref, out);
  });
  return { pages, copier };
}

/* The output of Pages mode: a new document holding plan's pages in order,
   each turned by its pending rotation on top of its own /Rotate.
   docs: { [src id]: PDFDocument }. → PDFDocument (not saved). */
async function pagesBuildPdf(PDFLib, docs, plan){
  const { PDFDocument, degrees } = PDFLib;
  // No Info dictionary of its own (no producer, no dates).
  const out = await PDFDocument.create({ updateMetadata: false });
  const bySrc = new Map();
  plan.forEach((p, k) => {
    if(!bySrc.has(p.src)) bySrc.set(p.src, []);
    bySrc.get(p.src).push(k);
  });
  const placed = new Array(plan.length);
  for(const [id, ks] of bySrc){
    const src = docs[id];
    if(!src) throw new Error('Missing source ' + id);
    // A page used twice gets a second, plain copy (copyPages): the seeded
    // copier maps each source page to one place.
    const first = [], again = [];
    const seen = new Set();
    ks.forEach(k => { const i = plan[k].index; if(seen.has(i)) again.push(k); else { seen.add(i); first.push(k); } });
    const { pages } = pdfCopyPagesSeeded(PDFLib, out, src, first.map(k => plan[k].index));
    first.forEach((k, j) => { placed[k] = pages[j]; });
    if(again.length){
      const extra = await out.copyPages(src, again.map(k => plan[k].index));
      again.forEach((k, j) => { placed[k] = extra[j]; });
    }
  }
  plan.forEach((p, k) => {
    const page = placed[k];
    const orig = (page.getRotation().angle || 0);
    page.setRotation(degrees((((orig + (p.rotate || 0)) % 360) + 360) % 360));
    out.addPage(page);
  });
  return out;
}
