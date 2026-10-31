'use strict';
/* ════════════════════════════════════════════════════════════════
   REDACT (#file/redact) — a mode under the File slice (spec §12, F-5).
   Black boxes burned into a picture: the pixels under them are destroyed,
   not covered, and the copy that comes out carries no metadata.

   Rail: Replace image (compact dropzone), Find text (an OCR search over the
   picture: Find runs the OCR panel's engine once, with its language and
   model, then every search reuses the words; Box all boxes every match,
   2 px padded), the {n} boxes badge with Undo and Clear, and the fixed
   "Burned in" hint.
   Pane: pane-bar (Redact · file · Done · Download redacted), the picture on
   a canvas. Drag draws a box, a click selects one, Delete removes it, the
   arrow keys nudge it (Shift: 10 px), Ctrl/⌘+Z undoes. Boxes are 85% black
   while editing; the selected one has the accent outline.

   Boxes live in image pixels (the picture as the browser shows it, EXIF
   orientation applied, as the image converter draws it), so the display
   size never matters to them. The output draws the full-resolution picture
   (HEIC decoded by js/heic.js) on an offscreen canvas, fills each box 100%
   black, re-encodes (js/lib/redact.js redactOutType), re-checks the bytes
   for EXIF and XMP (redactClean, the js/lib/scrub.js strips) and downloads
   <name>.redacted.<ext>.

   Ways in: the Redact card (images), a link to #file/redact (the
   short-hero). Done, Esc and Back go to #file (js/router.js).
   ════════════════════════════════════════════════════════════════ */
const RedactTool = (() => {
  const root = $('tool-redact');
  const canvas = $('rd-canvas'), stage = $('rd-stage'), work = $('rd-work'), empty = $('rd-empty');
  const railDrop = $('rd-drop'), tools = $('rd-tools'), fileEl = $('rd-file');
  const q = $('rd-q'), findBtn = $('rd-find'), findHint = $('rd-find-hint');
  const found = $('rd-found'), foundN = $('rd-found-n'), boxAllBtn = $('rd-boxall');
  const countEl = $('rd-count'), undoBtn = $('rd-undo'), clearBtn = $('rd-clear'), drawHint = $('rd-draw-hint');
  const saveBtn = $('rd-save'), statusEl = $('rd-status');

  const PAD = 2;               // px around an OCR word box (spec §12.1)
  const MAX_UPSCALE = 8;       // a small picture is shown bigger, up to this
  const MAX_BACKING = 4096;    // the editing canvas' own pixels, per side
  const DRAG_MIN = 3;          // CSS px a press moves before it is a drag

  /* src: { file, name, info, img, w, h, url } — the picture being redacted.
     boxes: [{ x, y, w, h }] in image pixels. hist: earlier boxes lists. */
  let src = null;
  let boxes = [], hist = [], sel = -1, lastNudge = -1;
  let words = null;            // the OCR words of src, once read
  let reading = null;          // the read in flight (a Promise)
  let matches = [];            // the last search's boxes
  let drag = null;             // { x0, y0, x1, y1 (CSS px), moved }
  let busy = false;
  let gen = 0;                 // bumped by every load: an older one stops
  let painted = false;

  const baseName = (n) => String(n || 'image').replace(/\.[^.]+$/, '') || 'image';
  const copy = (list) => list.map(b => ({ x: b.x, y: b.y, w: b.w, h: b.h }));

  /* ─── loading ─── */
  function loadImg(url){
    return new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => (i.naturalWidth && i.naturalHeight) ? res(i) : rej(new Error(T('Could not load image.')));
      i.onerror = () => rej(new Error(T('Could not load image.')));
      i.src = url;
    });
  }
  async function load(file, info){
    if(!file) return;
    const my = ++gen;
    if(!isImageLike(file)){
      try { info = info || await sniffFile(file); } catch(_){ info = null; }
      if(my !== gen) return;
      if(!info || (info.kind !== 'image' && info.kind !== 'heic')){ toast(fmtT('Could not open {name}', { name: file.name }), 'err'); return; }
    }
    let img, url;
    try {
      if(!info) info = await sniffFile(file).catch(() => null);
      // HEIC (by bytes, not by name) becomes a PNG here; the rest as is.
      const norm = await normalizeImageFile(file);
      url = URL.createObjectURL(norm);
      img = await loadImg(url);
    } catch(err){
      if(url) URL.revokeObjectURL(url);
      if(my === gen) toast(fmtT('Could not open {name}', { name: file.name }) + ' · ' + String(err && err.message || err), 'err');
      return;
    }
    if(my !== gen){ URL.revokeObjectURL(url); return; }
    if(src && src.url) URL.revokeObjectURL(src.url);
    src = { file, name: file.name, info, img, url, w: img.naturalWidth, h: img.naturalHeight };
    boxes = []; hist = []; sel = -1; lastNudge = -1;
    words = null; reading = null; matches = [];
    found.classList.add('hidden');
    findBtn.disabled = false;
    hintIdle();
    setText(statusEl, '');
    painted = false;
    render();
    fit();
  }
  function reset(){
    gen++;
    if(src && src.url) URL.revokeObjectURL(src.url);
    src = null;
    boxes = []; hist = []; sel = -1; words = null; reading = null; matches = [];
    found.classList.add('hidden');
    findBtn.disabled = false;
    hintIdle();
    render();
  }

  /* ─── the canvas ───
     Shown as large as fits the pane's width and 70% of the viewport's
     height; its own pixels are that size × devicePixelRatio, capped. */
  let shownW = 0;
  function fit(){
    if(!src || !root.classList.contains('active')) return;
    const cs = getComputedStyle(stage);
    const avail = stage.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    if(avail <= 0) return;
    const maxH = Math.max(120, window.innerHeight * 0.7 - 2);
    const s = Math.min(avail / src.w, maxH / src.h, MAX_UPSCALE);
    const cw = Math.max(1, Math.floor(src.w * s)), ch = Math.max(1, Math.floor(src.h * s));
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const k = Math.min(dpr, MAX_BACKING / cw, MAX_BACKING / ch);
    canvas.width = Math.max(1, Math.round(cw * k));
    canvas.height = Math.max(1, Math.round(ch * k));
    shownW = stage.clientWidth;
    draw();
  }
  let rafId = 0;
  const redraw = () => { if(!rafId) rafId = requestAnimationFrame(() => { rafId = 0; draw(); }); };
  function draw(){
    if(!src) return;
    const ctx = canvas.getContext('2d');
    const k = canvas.width / src.w, dpr = canvas.width / (parseFloat(canvas.style.width) || canvas.width);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = k < 2;   // a small picture shown big stays sharp
    ctx.drawImage(src.img, 0, 0, canvas.width, canvas.height);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0b57d0';
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    boxes.forEach(b => ctx.fillRect(b.x * k, b.y * k, b.w * k, b.h * k));
    const lw = Math.max(1, 2 * dpr);
    if(sel >= 0 && boxes[sel]){
      const b = boxes[sel];
      ctx.lineWidth = lw;
      ctx.strokeStyle = accent;
      ctx.strokeRect(b.x * k + lw / 2, b.y * k + lw / 2, Math.max(0, b.w * k - lw), Math.max(0, b.h * k - lw));
    }
    if(drag && drag.moved){
      const r = dragRect();
      if(r){
        ctx.fillRect(r.x * k, r.y * k, r.w * k, r.h * k);
        ctx.lineWidth = lw;
        ctx.strokeStyle = accent;
        ctx.setLineDash([4 * dpr, 3 * dpr]);
        ctx.strokeRect(r.x * k, r.y * k, r.w * k, r.h * k);
        ctx.setLineDash([]);
      }
    }
    painted = true;
  }

  /* ─── boxes ─── */
  function remember(){
    hist.push({ boxes: copy(boxes), sel });
    if(hist.length > 200) hist.shift();
    lastNudge = -1;
  }
  function changed(){
    setText(statusEl, '');
    render();
    redraw();
  }
  // Whole image pixels, outward, inside the picture.
  function snap(r){
    const x0 = Math.floor(r.x), y0 = Math.floor(r.y);
    const x1 = Math.ceil(r.x + r.w), y1 = Math.ceil(r.y + r.h);
    return clampRect({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, src.w, src.h);
  }
  function addBox(r){
    r = snap(r);
    if(r.w < 1 || r.h < 1) return false;
    if(boxes.some(b => b.x === r.x && b.y === r.y && b.w === r.w && b.h === r.h)) return false;
    boxes.push(r);
    return true;
  }
  function removeSelected(){
    if(sel < 0 || !boxes[sel]) return;
    remember();
    boxes.splice(sel, 1);
    sel = -1;
    changed();
  }
  function nudge(dx, dy){
    const b = boxes[sel];
    if(!b) return;
    // A run of nudges on one box is one step to undo.
    if(lastNudge !== sel){ remember(); lastNudge = sel; }
    b.x = Math.max(0, Math.min(src.w - b.w, b.x + dx));
    b.y = Math.max(0, Math.min(src.h - b.h, b.y + dy));
    changed();
  }
  function undo(){
    const h = hist.pop();
    if(!h) return;
    boxes = h.boxes;
    sel = h.sel < boxes.length ? h.sel : -1;
    lastNudge = -1;
    changed();
  }
  undoBtn.addEventListener('click', undo);
  clearBtn.addEventListener('click', () => {
    if(!boxes.length) return;
    remember();
    boxes = [];
    sel = -1;
    changed();
  });

  /* ─── pointer: drag draws, click selects ─── */
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(r.width, e.clientX - r.left)), y: Math.max(0, Math.min(r.height, e.clientY - r.top)), r };
  };
  function toImg(rect){
    const b = canvas.getBoundingClientRect();
    return toImageRect(rect, b.width, b.height, src.w, src.h);
  }
  function dragRect(){
    if(!drag) return null;
    return clampRect(toImg(normRect(drag.x0, drag.y0, drag.x1, drag.y1)), src.w, src.h);
  }
  canvas.addEventListener('pointerdown', e => {
    if(!src || busy || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    const p = local(e);
    drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, moved: false, id: e.pointerId };
    try { canvas.setPointerCapture(e.pointerId); } catch(_){}
    canvas.focus({ preventScroll: true });
  });
  canvas.addEventListener('pointermove', e => {
    if(!drag || e.pointerId !== drag.id) return;
    const p = local(e);
    drag.x1 = p.x; drag.y1 = p.y;
    if(!drag.moved && Math.hypot(drag.x1 - drag.x0, drag.y1 - drag.y0) >= DRAG_MIN) drag.moved = true;
    if(drag.moved) redraw();
  });
  canvas.addEventListener('pointerup', e => {
    if(!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if(d.moved){
      const r = toImg(normRect(d.x0, d.y0, d.x1, d.y1));
      remember();
      if(addBox(r)) sel = boxes.length - 1;
      else hist.pop();
      changed();
      return;
    }
    // A click: the topmost box under it, or none.
    const pt = toImg({ x: d.x0, y: d.y0, w: 0, h: 0 });
    let hit = -1;
    for(let i = boxes.length - 1; i >= 0; i--){
      const b = boxes[i];
      if(pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h){ hit = i; break; }
    }
    if(hit !== sel){ sel = hit; lastNudge = -1; redraw(); }
  });
  canvas.addEventListener('pointercancel', () => { drag = null; redraw(); });

  /* ─── keys (spec §19): Delete, arrows, Ctrl/⌘+Z. Never while typing. ─── */
  window.addEventListener('keydown', e => {
    if(!src || !root.classList.contains('active') || e.defaultPrevented) return;
    if(inTextField(document.activeElement) || e.altKey) return;
    if(window.CarinoUI && CarinoUI.modal && CarinoUI.modal.top()) return;
    if((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')){
      if(!hist.length) return;
      e.preventDefault();
      undo();
      return;
    }
    if(e.ctrlKey || e.metaKey || sel < 0) return;
    if(e.key === 'Delete' || e.key === 'Backspace'){ e.preventDefault(); removeSelected(); return; }
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if(!d) return;
    e.preventDefault();
    nudge(d[0], d[1]);
  });

  /* ─── Find text ───
     The words are read once per picture (the OCR panel's engine, language
     and model, js/ws/ocr.js readWords), on the full-resolution picture, so
     their boxes are already in image pixels. */
  function hintIdle(){
    if(words) setText(findHint, '');
    else setText(findHint, 'Reads the text first (once)');
  }
  async function readText(){
    if(words) return words;
    if(reading) return reading;
    const my = gen, s = src;
    reading = (async () => {
      const c = document.createElement('canvas');
      c.width = s.w; c.height = s.h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, s.w, s.h);
      ctx.drawImage(s.img, 0, 0);
      try {
        const data = await OcrTool.readWords(c, (k, v) => { if(my === gen) setText(findHint, k, v); });
        return redactWordsOf(data);
      } finally { c.width = c.height = 0; }
    })();
    try {
      const w = await reading;
      if(my !== gen) return null;
      words = w;
      return w;
    } finally { if(my === gen) reading = null; }
  }
  async function find(){
    const query = q.value.trim();
    if(!src || !query || findBtn.disabled) return;
    const my = gen;
    findBtn.disabled = true;
    found.classList.add('hidden');
    try {
      const w = await readText();
      if(my !== gen || !w) return;
      matches = matchWords(w, query);
      if(matches.length){
        setText(findHint, '');
        setText(foundN, 'Found {n}', { n: matches.length });
        found.classList.remove('hidden');
      } else setText(findHint, 'No matches');
    } catch(err){
      if(my === gen) setText(findHint, 'Error: {msg}', { msg: String(err && err.message || err) });
    } finally {
      if(my === gen) findBtn.disabled = false;
    }
  }
  findBtn.addEventListener('click', find);
  q.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); find(); } });
  // A new query: the last results no longer answer it.
  q.addEventListener('input', () => {
    if(reading) return;
    matches = [];
    found.classList.add('hidden');
    hintIdle();
  });
  boxAllBtn.addEventListener('click', () => {
    if(!src || !matches.length) return;
    remember();
    let added = 0;
    matches.forEach(m => { if(addBox(padRect(m, PAD, src.w, src.h))) added++; });
    if(!added){ hist.pop(); return; }
    sel = -1;
    changed();
  });

  /* ─── output ─── */
  async function save(){
    if(!src || !boxes.length || busy) return;
    const s = src, list = copy(boxes), my = gen;
    busy = true;
    render();
    const c = document.createElement('canvas');
    try {
      let out = redactOutType((s.info && s.info.det && s.info.det.mime) || s.file.type);
      c.width = s.w; c.height = s.h;
      const ctx = c.getContext('2d');
      if(out.mime === 'image/jpeg'){ ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, s.w, s.h); }
      ctx.drawImage(s.img, 0, 0);
      ctx.fillStyle = '#000';
      list.forEach(b => ctx.fillRect(b.x, b.y, b.w, b.h));
      let blob = await new Promise(r => c.toBlob(r, out.mime, out.quality));
      if(!blob) throw new Error(T('Encoding failed for {name}').replace('{name}', s.name));
      // A browser that cannot write WebP hands back a PNG: name it so.
      if(blob.type && blob.type !== out.mime) out = redactOutType(blob.type);
      const clean = redactClean(new Uint8Array(await blob.arrayBuffer()), out.mime);
      const name = baseName(s.name) + '.redacted.' + out.ext;
      if(my !== gen) return;
      downloadBlob(new Blob([clean.bytes], { type: out.mime }), name);
      setText(statusEl, 'Burned in {n} areas · metadata removed', { n: list.length });
      toast(T('Downloaded') + ' ' + name);
    } catch(err){
      if(my === gen) setText(statusEl, 'Error: {msg}', { msg: String(err && err.message || err) });
    } finally {
      c.width = c.height = 0;
      busy = false;
      render();
    }
  }
  saveBtn.addEventListener('click', save);

  /* ─── the panes ─── */
  function render(){
    const has = !!src;
    empty.classList.toggle('hidden', has);
    work.classList.toggle('hidden', !has);
    railDrop.classList.toggle('hidden', !has);
    tools.classList.toggle('hidden', !has);
    fileEl.textContent = has ? src.name : '';
    fileEl.title = has ? src.name : '';
    fileEl.classList.toggle('hidden', !has);
    if(boxes.length === 1) setText(countEl, '1 box'); else setText(countEl, '{n} boxes', { n: boxes.length });
    undoBtn.disabled = !hist.length;
    clearBtn.disabled = !boxes.length;
    drawHint.classList.toggle('hidden', boxes.length > 0);
    saveBtn.disabled = busy || !boxes.length;
    saveBtn.title = boxes.length ? '' : T('Draw a box first');
  }

  /* ─── ways in ─── */
  const take = (list) => {
    const f = Array.from(list || [])[0];
    if(f) load(f);
  };
  wireDrop(railDrop, $('rd-input'), take);
  wireDrop($('rd-hero-drop'), $('rd-input'), take);
  // A paste while Redact is up replaces the picture; registered before the
  // file screen's own paste handler (this script loads first).
  window.addEventListener('paste', e => {
    if(!root.classList.contains('active')) return;
    const fs = e.clipboardData && e.clipboardData.files;
    if(!fs || !fs.length) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    take(fs);
  });
  // The pane's width decides the canvas size: follow it (the rail folds
  // above the pane under 900px, the window turns).
  if('ResizeObserver' in window) new ResizeObserver(() => {
    if(src && stage.clientWidth && stage.clientWidth !== shownW) fit();
  }).observe(work);
  window.addEventListener('resize', () => { if(src) fit(); });

  modeDoneChip(root);
  window.addEventListener('files:i18n', render);
  hintIdle();
  render();

  /* state.redact: { file, info } from the Redact card. The same file again
     keeps its boxes; another one starts over. Anything else (a link, Back)
     keeps whatever the mode holds; nothing held shows the short-hero. */
  function enter(state){
    const r = state && state.redact;
    if(r && r.file && (!src || src.file !== r.file)){ load(r.file, r.info); return; }
    render();
    if(src){ fit(); if(!painted) draw(); }
  }
  function exit(){ drag = null; }

  FilesApp.register({
    id: 'redact', route: 'file/redact', parent: 'auto', mode: true, order: 45,
    accepts: (info) => !!info && (info.kind === 'image' || info.kind === 'heic'),
    outcomes: (info, files) => [{
      id: 'redact', rank: 70, icon: '⬛', title: T('Redact'),
      desc: T('Black out parts of the picture for good, then save a copy without metadata.'),
      run: (card) => FilesApp.enterMode('redact', { redact: { file: files[0], info } }, card),
    }],
    enter, exit,
  });

  return { load, reset, boxes: () => copy(boxes) };
})();
