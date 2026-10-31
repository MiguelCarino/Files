'use strict';
/* ════════════════════════════════════════════════════════════════
   PAGES (#file/pages) — a mode under the File slice (spec §10, F-3).
   One or more PDFs as one row of pages: merge, split, reorder, rotate,
   delete, extract. Nothing is written until an output is asked for: the
   edits are an op list with undo (js/lib/pageops.js), and pdf-lib builds the
   output from pagesPlan / splitPlan (pagesBuildPdf).

   Rail: Add PDFs (compact dropzone), Sources (one .file-chip per PDF, its
   letter in f-ico, ✕ removes its pages), Split (<details>, closed).
   Pane: pane-bar (Pages · {n} pages · Done · Export ▾ · Save PDF), the
   selection row, the grid of .rcard pages (lazy pdf.js thumbnails at about
   72 DPI, one pdf.js document per source, cached; the pending rotation is a
   CSS transform), or the empty states.

   Selection: click or Space toggles, Shift-click selects a range, Ctrl/⌘-
   click adds. Reorder: drag (pointer devices, HTML5 DnD), ‹ Move / Move ›
   everywhere, Shift+←/→. R rotates, Delete deletes, Ctrl/⌘+A selects all,
   Ctrl/⌘+Z undoes (none of them while typing in a field). Esc, Done and
   Back go to #file (js/router.js).

   Ways in: the Edit pages card (one PDF), the Merge PDFs set card (2+ PDFs,
   in tray order), a link to #file/pages (the short-hero).
   ════════════════════════════════════════════════════════════════ */
const PagesTool = (() => {
  const root = $('tool-pages');
  const grid = $('pg-grid'), empty = $('pg-empty'), work = $('pg-work'), none = $('pg-none');
  const count = $('pg-count'), saveBtn = $('pg-save'), exportBtn = $('pg-export-btn');
  const selN = $('pg-sel-n'), statusEl = $('pg-status');
  const btn = { all: $('pg-all'), rot: $('pg-rot'), del: $('pg-del'), left: $('pg-left'), right: $('pg-right'), undo: $('pg-undo') };
  const railDrop = $('pg-drop'), sourcesWrap = $('pg-sources-wrap'), sourcesBox = $('pg-sources'), split = $('pg-split');

  let state = pagesInit();
  let nextId = 1;
  let busy = false;
  let gen = 0;                 // bumped by reset(): an older addFiles stops adding
  const files = new Map();     // source id → { file, bytes, lib: Promise<PDFDocument> }
  const viewDocs = new Map();  // source id → Promise<pdf.js document>, for thumbnails
  const thumbs = new Map();    // page key → object URL
  const cards = new Map();     // page key → .rcard
  let away = false;            // the mode was left (exit); no thumbnails until it is back
  const selected = new Set();  // page keys
  let anchor = null;           // the last clicked key, for Shift-click
  let focusKey = null;         // the card in the tab order

  const keyOf = (p) => p.src + ':' + p.index;
  const indexOfKey = (k) => state.pages.findIndex(p => keyOf(p) === k);
  const selIdx = () => state.pages.map((p, i) => selected.has(keyOf(p)) ? i : -1).filter(i => i >= 0);
  const firstName = () => {
    const s = state.sources[0];
    return s ? s.name.replace(/\.[^.]+$/, '') || 'document' : 'document';
  };

  /* ─── sources ─── */
  async function addFiles(list){
    list = Array.from(list || []);
    if(!list.length) return;
    const my = gen;
    setText(statusEl, '');
    let PDFLibNs;
    try { PDFLibNs = await needLib('PDFLib'); }
    catch(e){ setText(statusEl, 'Error: {msg}', { msg: String(e && e.message || e) }); return; }
    for(const file of list){
      if(my !== gen) return;
      let bytes;
      try {
        const det = detectFormat(await headOf(file), file.name, file.type);
        if(!det || det.id !== 'pdf'){ setText(statusEl, 'Not a PDF: {name}', { name: file.name }); continue; }
        bytes = new Uint8Array(await file.arrayBuffer());
        const doc = await PDFLibNs.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
        if(my !== gen) return;
        if(doc.isEncrypted){
          setText(statusEl, '{x} · {y}', { x: { t: 'Could not open {name}', v: { name: file.name } }, y: { t: 'This PDF is encrypted.' } });
          continue;
        }
        const id = 's' + (nextId++);
        files.set(id, { file, bytes, lib: Promise.resolve(doc) });
        apply({ type: 'add-source', id, name: file.name, pageCount: doc.getPageCount() });
      } catch(e){
        console.error(e);
        setText(statusEl, '{x} · {y}', { x: { t: 'Could not open {name}', v: { name: file.name } }, y: String(e && e.message || e) });
      }
    }
  }
  // A source that left the state (removed, or its add undone) gives back its
  // thumbnails and its pdf.js document; its bytes stay, so Undo can bring
  // it back.
  function syncSources(){
    const live = new Set(state.sources.map(s => s.id));
    viewDocs.forEach((p, id) => {
      if(live.has(id)) return;
      viewDocs.delete(id);
      p.then(d => d.destroy()).catch(() => {});
    });
    thumbs.forEach((url, k) => {
      if(live.has(k.split(':')[0])) return;
      URL.revokeObjectURL(url);
      thumbs.delete(k);
    });
  }

  /* ─── the edit list ─── */
  function apply(op){
    const next = pagesApply(state, op);
    if(next === state) return false;
    state = next;
    changed();
    return true;
  }
  function undo(){
    if(!state.history.length) return;
    state = pagesUndo(state);
    changed();
  }
  function changed(){
    const keys = new Set(state.pages.map(keyOf));
    selected.forEach(k => { if(!keys.has(k)) selected.delete(k); });
    if(focusKey && !keys.has(focusKey)) focusKey = null;
    if(anchor && !keys.has(anchor)) anchor = null;
    syncSources();
    render();
  }

  /* ─── thumbnails ───
     One pdf.js document per source, opened when its first card scrolls
     near the view. Renders run one at a time; each page is cleaned up after
     its render, so a cached document never has two passes in flight. */
  let pdfjs = null;
  async function pdfjsLib(){
    if(pdfjs) return pdfjs;
    pdfjs = await import(new URL('vendor/pdfjs/pdf.min.mjs', location.href).href);
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.mjs', location.href).href;
    return pdfjs;
  }
  function viewDoc(id){
    if(!viewDocs.has(id)){
      const f = files.get(id);
      const p = pdfjsLib().then(lib => lib.getDocument({ data: f.bytes.slice() }).promise);
      p.catch(() => viewDocs.delete(id));
      viewDocs.set(id, p);
    }
    return viewDocs.get(id);
  }
  let queue = Promise.resolve();
  const pending = new Set();
  function wantThumb(key){
    if(thumbs.has(key) || pending.has(key)) return;
    pending.add(key);
    queue = queue.then(() => drawThumb(key)).catch(() => {}).then(() => {
      pending.delete(key);
      // Skipped or cut short because the mode was left: ask again when the
      // card is next on screen.
      const c = cards.get(key);
      if(away && !thumbs.has(key) && c && io) io.observe(c);
    });
  }
  const THUMB_MAX = 400;   // px on the long side: ~72 DPI for a letter page, less for a poster
  async function drawThumb(key){
    const card = cards.get(key);
    if(away || !card || !card.isConnected || thumbs.has(key)) return;
    const [id, n] = key.split(':');
    if(!files.has(id) || !state.sources.some(s => s.id === id)) return;
    const doc = await viewDoc(id);
    const page = await doc.getPage(Number(n) + 1);
    try {
      const v1 = page.getViewport({ scale: 1 });
      const scale = Math.min(1, THUMB_MAX / Math.max(v1.width, v1.height));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(vp.width));
      canvas.height = Math.max(1, Math.ceil(vp.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.8));
      canvas.width = canvas.height = 0;
      if(!blob || !state.sources.some(s => s.id === id)) return;
      const url = URL.createObjectURL(blob);
      thumbs.set(key, url);
      const img = cards.get(key) && cards.get(key).querySelector('img');
      if(img) img.src = url;
    } finally { page.cleanup(); }
  }
  const io = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    entries.forEach(e => { if(e.isIntersecting){ io.unobserve(e.target); wantThumb(e.target.dataset.key); } });
  }, { rootMargin: '300px 0px' }) : null;

  /* ─── the pane ─── */
  function makeCard(key){
    const c = document.createElement('div');
    c.className = 'rcard pg-card';
    c.dataset.key = key;
    c.setAttribute('role', 'option');
    c.tabIndex = -1;
    c.draggable = true;
    c.innerHTML = '<div class="thumb"><img alt="" draggable="false"></div><div class="rbody"><div class="rmeta"><span class="chip pg-n"></span><span class="pg-src"></span></div></div>';
    cards.set(key, c);
    if(thumbs.has(key)) c.querySelector('img').src = thumbs.get(key);
    else if(io) io.observe(c);
    else wantThumb(key);
    return c;
  }
  function render(){
    const n = state.pages.length, has = state.sources.length > 0;
    empty.classList.toggle('hidden', has);
    work.classList.toggle('hidden', !has);
    railDrop.classList.toggle('hidden', !has);
    sourcesWrap.classList.toggle('hidden', !has);
    split.classList.toggle('hidden', !has);
    count.classList.toggle('hidden', !has);
    if(n === 1) setText(count, '1 page'); else setText(count, '{n} pages', { n });
    none.classList.toggle('hidden', n > 0 || !has);
    $('pg-sel').classList.toggle('hidden', n === 0);
    grid.classList.toggle('hidden', n === 0);

    // Cards: reused by key, so a thumbnail and the focus survive a move.
    const multi = state.sources.length > 1;
    const letter = new Map(state.sources.map(s => [s.id, s.letter]));
    const keys = new Set();
    if(!focusKey && n) focusKey = keyOf(state.pages[0]);
    state.pages.forEach((p, i) => {
      const k = keyOf(p);
      keys.add(k);
      const c = cards.get(k) || makeCard(k);
      const sel = selected.has(k);
      c.setAttribute('aria-selected', sel ? 'true' : 'false');
      c.classList.toggle('pg-on', sel);
      c.tabIndex = k === focusKey ? 0 : -1;
      c.querySelector('.pg-n').textContent = String(i + 1);
      c.querySelector('.pg-src').textContent = multi ? letter.get(p.src) || '' : '';
      const img = c.querySelector('img');
      img.style.transform = p.rotate ? 'rotate(' + p.rotate + 'deg)' + (p.rotate % 180 ? ' scale(0.72)' : '') : '';
      const label = fmtT('Page {n}', { n: i + 1 }) + (multi ? ' · ' + (letter.get(p.src) || '') : '') + (p.rotate ? ' · ' + p.rotate + '°' : '');
      c.setAttribute('aria-label', label);
      if(grid.children[i] !== c) grid.insertBefore(c, grid.children[i] || null);
    });
    cards.forEach((c, k) => {
      if(keys.has(k)) return;
      if(io) io.unobserve(c);
      c.remove();
      cards.delete(k);
    });

    // The selection row and the outputs.
    const k = selected.size;
    setText(selN, '{n} selected', { n: k });
    btn.all.disabled = !n || k === n;
    [btn.rot, btn.del, btn.left, btn.right].forEach(b => { b.disabled = !k || busy; });
    btn.undo.disabled = !state.history.length || busy;
    saveBtn.disabled = !n || busy;
    // A disabled primary says why (spec §3.3).
    if(!n) saveBtn.title = T(has ? 'No pages left' : 'Add PDFs');
    else saveBtn.removeAttribute('title');
    exportBtn.disabled = !n || busy;
    $('pg-export-sel').disabled = !k;
    paintSources();
  }

  function paintSources(){
    sourcesBox.innerHTML = '';
    const left = new Map();
    state.pages.forEach(p => left.set(p.src, (left.get(p.src) || 0) + 1));
    state.sources.forEach(s => {
      const chip = document.createElement('div');
      chip.className = 'file-chip';
      chip.setAttribute('role', 'listitem');
      const ico = document.createElement('div');
      ico.className = 'f-ico';
      ico.textContent = s.letter;
      const info = document.createElement('div');
      info.className = 'f-info';
      const name = document.createElement('div');
      name.className = 'f-name';
      name.textContent = s.name;
      name.title = s.name;
      const meta = document.createElement('div');
      meta.className = 'f-meta';
      const pn = left.get(s.id) || 0;
      if(pn === 1) setText(meta, '1 page'); else setText(meta, '{n} pages', { n: pn });
      info.append(name, meta);
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'f-x';
      x.textContent = '✕';
      x.title = T('Remove');
      x.setAttribute('aria-label', T('Remove') + ' · ' + s.name);
      x.addEventListener('click', () => {
        apply({ type: 'remove-source', id: s.id });
        const next = sourcesBox.querySelector('.f-x') || (state.sources.length ? railDrop : $('pg-hero-drop'));
        if(next) next.focus({ preventScroll: true });
      });
      chip.append(ico, info, x);
      sourcesBox.append(chip);
    });
  }

  /* ─── selection and focus ─── */
  function focusCard(key, scroll){
    if(!key) return;
    focusKey = key;
    cards.forEach((c, k) => { c.tabIndex = k === key ? 0 : -1; });
    const c = cards.get(key);
    if(c){ c.focus({ preventScroll: true }); if(scroll !== false) c.scrollIntoView({ block: 'nearest' }); }
  }
  function toggle(key){
    if(selected.has(key)) selected.delete(key); else selected.add(key);
    anchor = key;
    render();
  }
  function selectRange(key){
    const a = anchor ? indexOfKey(anchor) : -1, b = indexOfKey(key);
    if(a < 0){ toggle(key); return; }
    for(let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(keyOf(state.pages[i]));
    render();
  }
  function selectAll(){
    state.pages.forEach(p => selected.add(keyOf(p)));
    render();
  }
  // What R, Delete and the move keys act on: the selection, or the focused
  // card when nothing is selected.
  function targets(){
    const s = selIdx();
    if(s.length) return s;
    const f = focusKey ? indexOfKey(focusKey) : -1;
    return f >= 0 ? [f] : [];
  }
  function move(dir, idx){
    idx = idx || selIdx();
    if(!idx.length) return;
    const k = idx.length, lo = Math.min.apply(null, idx), hi = Math.max.apply(null, idx);
    const to = dir < 0 ? Math.max(0, lo - 1) : Math.min(state.pages.length - k, hi - k + 2);
    apply({ type: 'move', indices: idx, to });
    if(focusKey) focusCard(focusKey);
  }
  function rotate(idx){ apply({ type: 'rotate', indices: idx || selIdx(), by: 90 }); }
  function del(idx){
    idx = idx || selIdx();
    if(!idx.length) return;
    // Focus goes to the page after the last one deleted (or before it).
    const after = state.pages[Math.max.apply(null, idx) + 1] || state.pages[Math.min.apply(null, idx) - 1];
    apply({ type: 'delete', indices: idx });
    if(after) focusCard(keyOf(after)); else if(!state.pages.length) btn.undo.focus();
  }

  grid.addEventListener('click', e => {
    const c = e.target.closest('.pg-card');
    if(!c) return;
    const k = c.dataset.key;
    focusKey = k;
    if(e.shiftKey) selectRange(k);
    else toggle(k);   // a plain click toggles; Ctrl/⌘-click adds, which is the same here
    focusCard(k, false);
  });
  grid.addEventListener('keydown', e => {
    const c = e.target.closest('.pg-card');
    if(!c || e.altKey) return;
    // The card the key landed on is the focused one, however it got focus.
    focusKey = c.dataset.key;
    const i = indexOfKey(c.dataset.key);
    const cols = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length);
    const go = (j) => { j = Math.max(0, Math.min(state.pages.length - 1, j)); focusCard(keyOf(state.pages[j])); };
    if(e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')){
      e.preventDefault();
      move(e.key === 'ArrowLeft' ? -1 : 1, targets());
      return;
    }
    if(e.ctrlKey || e.metaKey) return;
    switch(e.key){
      case 'ArrowLeft':  e.preventDefault(); go(i - 1); break;
      case 'ArrowRight': e.preventDefault(); go(i + 1); break;
      case 'ArrowUp':    e.preventDefault(); go(i - cols); break;
      case 'ArrowDown':  e.preventDefault(); go(i + cols); break;
      case 'Home':       e.preventDefault(); go(0); break;
      case 'End':        e.preventDefault(); go(state.pages.length - 1); break;
      case ' ': case 'Enter':
        e.preventDefault();
        if(e.shiftKey) selectRange(c.dataset.key); else toggle(c.dataset.key);
        focusCard(c.dataset.key, false);
        break;
      case 'r': case 'R': e.preventDefault(); rotate(targets()); focusCard(c.dataset.key); break;
      case 'Delete': case 'Backspace': e.preventDefault(); del(targets()); break;
    }
  });
  // Ctrl/⌘+A and Ctrl/⌘+Z anywhere in the mode, outside text fields.
  window.addEventListener('keydown', e => {
    if(!root.classList.contains('active') || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if(inTextField(document.activeElement)) return;
    if(window.CarinoUI && CarinoUI.modal && CarinoUI.modal.top()) return;
    const k = e.key.toLowerCase();
    if(k === 'a' && state.pages.length){ e.preventDefault(); selectAll(); }
    else if(k === 'z' && state.history.length && !busy){ e.preventDefault(); undo(); if(focusKey) focusCard(focusKey); }
  });

  /* Drag to reorder (pointer devices). The dragged pages are the selection
     when the card is selected, else that card alone; they land before or
     after the card under the pointer, by which half it is over. */
  let dragging = null;
  const clearMarks = () => grid.querySelectorAll('.pg-before, .pg-after').forEach(x => x.classList.remove('pg-before', 'pg-after'));
  grid.addEventListener('dragstart', e => {
    const c = e.target.closest('.pg-card');
    if(!c || busy){ e.preventDefault(); return; }
    const k = c.dataset.key;
    dragging = selected.has(k) ? selIdx() : [indexOfKey(k)];
    c.classList.add('pg-drag');
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', k); } catch(_){}
  });
  grid.addEventListener('dragend', e => {
    dragging = null;
    clearMarks();
    grid.querySelectorAll('.pg-drag').forEach(x => x.classList.remove('pg-drag'));
  });
  const side = (c, e) => { const r = c.getBoundingClientRect(); return e.clientX > r.left + r.width / 2 ? 'after' : 'before'; };
  grid.addEventListener('dragover', e => {
    if(!dragging) return;
    const c = e.target.closest('.pg-card');
    if(!c) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch(_){}
    clearMarks();
    c.classList.add(side(c, e) === 'after' ? 'pg-after' : 'pg-before');
  });
  grid.addEventListener('drop', e => {
    if(!dragging) return;
    const c = e.target.closest('.pg-card');
    e.preventDefault();
    e.stopPropagation();
    clearMarks();
    if(!c){ dragging = null; return; }
    const at = indexOfKey(c.dataset.key) + (side(c, e) === 'after' ? 1 : 0);
    // `to` counts positions with the moved pages taken out.
    const to = at - dragging.filter(i => i < at).length;
    apply({ type: 'move', indices: dragging, to });
    dragging = null;
  });

  btn.all.addEventListener('click', selectAll);
  btn.rot.addEventListener('click', () => rotate());
  btn.del.addEventListener('click', () => del());
  btn.left.addEventListener('click', () => move(-1));
  btn.right.addEventListener('click', () => move(1));
  btn.undo.addEventListener('click', undo);

  /* ─── outputs (pdf-lib) ─── */
  async function docs(){
    const out = {};
    for(const s of state.sources) out[s.id] = await files.get(s.id).lib;
    return out;
  }
  async function build(plan){
    const lib = await needLib('PDFLib');
    const doc = await pagesBuildPdf(lib, await docs(), plan);
    return new Blob([await doc.save()], { type: 'application/pdf' });
  }
  async function run(fn){
    if(busy) return;
    busy = true;
    render();
    setText(statusEl, '');
    try { await fn(); }
    catch(e){ console.error(e); setText(statusEl, 'Error: {msg}', { msg: String(e && e.message || e) }); }
    finally { busy = false; render(); }
  }
  const saved = (blob, name) => { downloadBlob(blob, name); toast(T('Downloaded') + ' ' + name); };
  saveBtn.addEventListener('click', () => run(async () => {
    if(!state.pages.length) return;
    saved(await build(pagesPlan(state)), firstName() + '.pages.pdf');
  }));
  $('pg-export-sel').addEventListener('click', () => run(async () => {
    const idx = selIdx();
    if(!idx.length) return;
    saved(await build(pagesPlan(state, idx)), firstName() + '.selected.pdf');
  }));
  $('pg-export-split').addEventListener('click', () => run(async () => {
    const mode = $('pg-split-ranges').checked ? 'ranges' : 'every';
    const groups = splitPlan(state, mode, $('pg-range').value);
    if(!groups.length){ setText(statusEl, 'No valid pages selected'); return; }
    setText(statusEl, 'Building ZIP…');
    const base = firstName();
    const entries = [], used = new Map();
    for(const g of groups){
      // '1-3, 1-3' gives the same label twice: one ZIP entry name each.
      const stem = base + '.p' + g.label, k = used.get(stem) || 0;
      used.set(stem, k + 1);
      entries.push({ name: stem + (k ? '-' + (k + 1) : '') + '.pdf', blob: await build(g.plan) });
    }
    saved(await makeZip(entries), base + '.split.zip');
    setText(statusEl, '');
  }));
  menuKeys(exportBtn, $('pg-export-menu'));

  /* ─── ways in ─── */
  const take = (list) => addFiles(list);
  wireDrop(railDrop, $('pg-input'), take, { multiple: true });
  wireDrop($('pg-hero-drop'), $('pg-input'), take, { multiple: true });
  // A paste while Pages is up adds PDFs; registered before the file
  // screen's own paste handler (this script loads first).
  window.addEventListener('paste', e => {
    if(!root.classList.contains('active')) return;
    const fs = e.clipboardData && e.clipboardData.files;
    if(!fs || !fs.length) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    take(fs);
  });
  // The phone's sticky selection row sits under the sticky pane-bar,
  // whose height changes when it wraps.
  const bar = root.querySelector('.pane-bar');
  if(bar && 'ResizeObserver' in window) new ResizeObserver(() => root.style.setProperty('--pg-bar-h', bar.offsetHeight + 'px')).observe(bar);

  const done = modeDoneChip(root);
  if(done) count.after(done);   // title · {n} pages · Done (spec §3.1)
  window.addEventListener('files:i18n', render);
  render();

  /* state.pages: [{ file, info }] from a card (Edit pages, Merge PDFs): the
     mode starts over with those PDFs, in that order. Anything else (a link,
     Back) keeps what the mode holds. */
  async function enter(st){
    away = false;
    if(st && Array.isArray(st.pages)){
      reset();
      // Focus stays on the pane title (showTool); the first page is the
      // grid's tab stop.
      await addFiles(st.pages.map(x => x.file));
    } else render();
  }
  /* Leaving the mode (Done, Esc, Back) closes every pdf.js document, and
     with it its worker and its copy of the bytes. The edit list, the
     sources' bytes and the thumbnails stay, so coming back shows the same
     work; viewDoc() reopens a document when a card needs a thumbnail. */
  function exit(){
    away = true;
    viewDocs.forEach(p => p.then(d => d.destroy()).catch(() => {}));
    viewDocs.clear();
  }
  function reset(){
    gen++;
    state = pagesInit();
    selected.clear();
    anchor = focusKey = null;
    syncSources();
    files.clear();
    setText(statusEl, '');
    render();
  }

  FilesApp.register({
    id: 'pages', route: 'file/pages', parent: 'auto', mode: true, order: 40,
    accepts: (info) => !!info && info.kind === 'pdf',
    outcomes: (info, files) => [{
      id: 'edit-pages', rank: 75, icon: '📑', title: T('Edit pages'),
      desc: T('Reorder, rotate, delete or extract pages, or split the PDF.'),
      run: (card) => FilesApp.enterMode('pages', { pages: [{ file: files[0], info }] }, card),
    }],
    setOutcomes: (set) => {
      const pdfs = set.filter(x => x.info && x.info.kind === 'pdf');
      if(pdfs.length < 2) return [];
      return [{
        id: 'merge-pdfs', rank: 70, icon: '📑', title: T('Merge PDFs'),
        desc: T('One PDF from these, in tray order; then reorder or drop pages.') + ' ' + fmtT('{k} of {n} files', { k: pdfs.length, n: set.length }),
        run: (card) => FilesApp.enterMode('pages', { pages: pdfs.map(x => ({ file: x.file, info: x.info })) }, card),
      }];
    },
    enter,
    exit,
  });

  return { state: () => state, add: addFiles, reset };
})();
