'use strict';
/* ════════════════════════════════════════════════════════════════
   2 · OCR  (vendored tesseract.js, fully offline)
   ════════════════════════════════════════════════════════════════ */
const OcrTool = (() => {
  const VENDOR = new URL('vendor/tesseract/', location.href).href;
  /* Two models per language (spec §7.2, O-2): Fast (tessdata_fast, the
     default, a quarter of the download) and Best (the full tessdata models
     this site always shipped). The worker fetches <langPath>/<lang>.traineddata.gz
     and keeps it in IndexedDB under <cachePath>/<lang>.traineddata, so each
     model gets its own cachePath: same file name, different bytes. Best keeps
     the default '.' so a model already cached by an earlier version is reused. */
  const MODELS = {
    fast: { langPath: new URL('vendor/tessdata/fast', location.href).href, cachePath: 'tessdata-fast' },
    best: { langPath: new URL('vendor/tessdata', location.href).href, cachePath: '.' },
  };
  const MODEL_KEY = 'files-ocr-model';
  const optsFor = (model) => ({
    workerPath: VENDOR + 'worker.min.js',
    corePath:   VENDOR,                 // worker appends tesseract-core-*[-lstm].wasm.js
    langPath:   MODELS[model].langPath,
    cachePath:  MODELS[model].cachePath,
    gzip:       true,
    workerBlobURL: false,
  });
  // Word boxes come back only inside blocks (tesseract.js v6+).
  const OUTPUT = { text: true, blocks: true };

  let worker = null, workerP = null, workerKey = '';
  let currentFile = null, doc = null;
  let invertForOCR = false, rotation = 0;
  let jobId = 0, busy = false;
  let docRun = null;          // { cancel: bool } while "Searchable PDF (all pages)" runs
  let lastResult = null;      // { file, rotation, words, w, h } — the last image read
  // Opened once in this page session: from then on the next image or PDF
  // that lands may prefetch the engine while the page is idle (spec §7.1).
  let opened = false;
  // Runs are serialised on this chain so a second run queued while the first
  // is still recognising waits its turn instead of being dropped.
  let runChain = Promise.resolve();

  /* The panel only appears when Extract text is pressed (O-1): nothing under
     vendor/tesseract or vendor/tessdata is requested before that. The image
     it recognises is the same <img> the screen renders, which is why "Invert
     view" flips what you are actually looking at. The file screen owns the
     picture (it alone assigns thumb.src); this module only styles it. */
  const preview = $('auto-thumb');
  const output = $('ao-text'), bar = $('ao-bar'), stateEl = $('ao-state');
  const runBtn = $('ocr-run'), langSel = $('ocr-lang'), pdfBtn = $('ocr-pdf');
  const invView = $('ocr-invert-view'), invOcr = $('ocr-invert'), rotBtn = $('ocr-rotate'), rotDeg = $('ocr-rot-deg');
  const modelRadios = Array.from(document.querySelectorAll('input[name="ocr-model"]'));

  // By key and vars (setText), so the badge follows a language switch.
  const setState = (key, vars) => setText(stateEl, key, vars);
  const model = () => { const r = modelRadios.find(x => x.checked); return r && MODELS[r.value] ? r.value : 'fast'; };

  // The remembered model; Fast unless Best was chosen before.
  try {
    const saved = localStorage.getItem(MODEL_KEY);
    if(saved && MODELS[saved]) modelRadios.forEach(r => { r.checked = r.value === saved; });
  } catch(_){}

  function syncRot(){ rotDeg.textContent = rotation + '°'; }
  // The searchable-PDF button: one image, or every page of the PDF on screen,
  // or Cancel while that runs. Fixed keys, through setText.
  function syncPdfBtn(){
    if(docRun) setText(pdfBtn, 'Cancel');
    else setText(pdfBtn, doc ? 'Searchable PDF (all pages)' : 'Searchable PDF');
  }
  function setBusy(v){
    busy = v;
    const dis = v || !currentFile;
    runBtn.disabled = dis;
    [invOcr, rotBtn, $('ocr-download')].forEach(el => el.disabled = dis);
    invView.disabled = !currentFile;
    // During an all-pages run this same button cancels it.
    pdfBtn.disabled = docRun ? false : (v || !(currentFile || doc));
    langSel.disabled = v;
    modelRadios.forEach(r => r.disabled = v);
    syncPdfBtn();
  }
  function setProgress(pct){ setBar(bar, pct); }

  function clearOutput(){
    jobId++;
    lastResult = null;
    setRaw(output, '');
    setProgress(0);
  }
  // Everything off: no image, no document, the switches back to off.
  function resetUI(){
    // An all-pages run stops now, not at the end of the page it is reading.
    if(docRun){ docRun.cancel = true; dropWorker(); }
    clearOutput();
    currentFile = null; doc = null; invertForOCR = false; rotation = 0;
    invView.checked = false; invOcr.checked = false;
    setRaw(stateEl, '…');
    preview.classList.remove('inverted');
    syncRot();
    setBusy(false);
  }

  /* Arm the panel for an image and hand the decoded file back, so the caller
     can put that exact file on screen — HEIC arrives here as something no
     <img> can render and leaves as a PNG. Null means it was not an image, or
     the decode failed and the panel already says so. */
  async function load(file){
    if(!file || !isImageLike(file)) return null;
    try { file = await normalizeImageFile(file); }
    catch(err){ setText(output, 'Error: {msg}', { msg: String(err && err.message || err) }); setState('Error'); return null; }
    if(!file.type || !file.type.startsWith('image/')) return null;
    clearOutput();   // a new image supersedes anything still recognising
    currentFile = file;
    preview.classList.toggle('inverted', invView.checked);
    rotation = 0; syncRot();
    setState('Ready'); setBusy(false);
    return file;
  }

  // The PDF on the file screen, for "Searchable PDF (all pages)": its name and
  // a page walker (PdfTool.eachOcrPage). Null when the screen holds no PDF.
  function setDoc(d){ doc = d || null; setBusy(busy); }

  /* The worker for the language and model chosen now. One promise, shared,
     so a prefetch still loading and a click that wants the engine meet on
     the same worker instead of starting two. */
  function getWorker(){
    const key = langSel.value + '|' + model();
    if(workerP && workerKey === key) return workerP;
    const lang = langSel.value, mdl = model();
    workerKey = key;
    workerP = (async () => {
      // tesseract.js is fetched the first time it is needed, not with the page.
      const Tess = await needLib('Tesseract');
      return Tess.createWorker(lang, 1, Object.assign({
        logger: (msg) => { if(onLog) onLog(msg); },
      }, optsFor(mdl)));
    })();
    workerP.then(w => { if(workerKey === key) worker = w; else { try { w.terminate(); } catch(_){} } },
                 () => { if(workerKey === key){ workerP = null; workerKey = ''; } });
    return workerP;
  }
  // Where the engine's progress goes: the bar and the badge while a run owns
  // the panel, nowhere during a quiet prefetch.
  let onLog = null;
  function logToPanel(m){
    const pct = Math.round((m.progress || 0) * 100);
    setProgress(pct);
    // Tesseract's own status words are English and stay so.
    if(m.status === 'recognizing text') setState('Recognizing… {pct}%', { pct });
    else if(m.status) setRaw(stateEl, m.status);
    else setState('Loading engine');
  }
  async function dropWorker(){
    const p = workerP;
    workerP = null; workerKey = ''; worker = null;
    if(p){ try { (await p).terminate(); } catch(_){} }
  }

  /* After the panel has been opened once: load Tesseract and the chosen model
     while the page is idle, so the next Extract text starts at once. */
  function prefetch(){
    if(!opened || workerP) return;
    const idle = window.requestIdleCallback || (fn => setTimeout(fn, 1500));
    idle(() => { if(opened && !workerP) getWorker().catch(() => {}); });
  }
  function markOpened(){ opened = true; }

  // A language or model change throws the worker away; the next run makes one.
  async function engineChanged(){
    if(busy) return;   // the controls are disabled while a run owns the panel
    setBusy(true);
    await dropWorker();
    setBusy(false);
    if(currentFile) setState('Ready'); else setState('Idle');
  }
  langSel.addEventListener('change', engineChanged);
  modelRadios.forEach(r => r.addEventListener('change', () => {
    try { localStorage.setItem(MODEL_KEY, model()); } catch(_){}
    engineChanged();
  }));

  /* The image as Tesseract gets it: rotated, optionally inverted. Also the
     picture a searchable PDF draws (never inverted: invert: false), so the
     word boxes and the drawn pixels share one geometry. */
  function orient(file, invert, type = 'image/png', quality = 1){
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        try {
          const w = img.naturalWidth, h = img.naturalHeight;
          const rot = ((rotation % 360) + 360) % 360;
          const swap = rot === 90 || rot === 270;
          const canvas = document.createElement('canvas');
          canvas.width = swap ? h : w;
          canvas.height = swap ? w : h;
          const ctx = canvas.getContext('2d', { willReadFrequently: invert });
          if(type === 'image/jpeg'){ ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
          ctx.save();
          ctx.translate(canvas.width / 2, canvas.height / 2);
          ctx.rotate(rot * Math.PI / 180);
          ctx.drawImage(img, -w / 2, -h / 2);
          ctx.restore();
          if(invert) invertCanvas(canvas);
          const cw = canvas.width, ch = canvas.height;
          canvas.toBlob(blob => {
            URL.revokeObjectURL(url);
            canvas.width = canvas.height = 0;
            blob ? resolve({ blob, w: cw, h: ch }) : reject(new Error(T('Failed to preprocess image.')));
          }, type, quality);
        } catch(err){ URL.revokeObjectURL(url); reject(err); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(T('Could not load image.'))); };
      img.src = url;
    });
  }
  function invertCanvas(canvas){
    const ctx = canvas.getContext('2d');
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const p = d.data;
    for(let i = 0; i < p.length; i += 4){ p[i] = 255 - p[i]; p[i+1] = 255 - p[i+1]; p[i+2] = 255 - p[i+2]; }
    ctx.putImageData(d, 0, 0);
  }

  function queue(fn){
    const p = runChain.then(fn, fn);   // queue behind any run still in flight
    runChain = p.catch(() => {});
    return p;
  }
  function runOCR(){
    if(!currentFile) return Promise.resolve(null);
    const job = ++jobId, file = currentFile;
    return queue(() => doOCR(job, file));
  }

  async function doOCR(job, file){
    if(!file || job !== jobId) return null;   // superseded while it waited its turn
    setBusy(true); setState(worker ? 'Running OCR' : 'Loading engine');
    setRaw(output, '');
    setProgress(0);
    onLog = logToPanel;
    try {
      const w = await getWorker();
      if(job !== jobId) return null;
      const rot = rotation;
      const { blob, w: iw, h: ih } = await orient(file, invertForOCR);
      if(job !== jobId) return null;
      setState('Running OCR');
      const { data } = await w.recognize(blob, {}, OUTPUT);
      if(job !== jobId) return null;
      lastResult = { file, rotation: rot, words: ocrWordsOf(data), w: iw, h: ih };
      const text = (data && data.text || '').trim();
      if(text) setRaw(output, text); else setText(output, 'No text found in this image.');
      const confidence = Math.round(data && data.confidence || 0);
      setProgress(100);
      setState('Done · {pct}%', { pct: confidence });
      // Announced through the toast (a live region): the text lands silently.
      toast(text ? `${T('Text extracted')} · ${confidence}%` : T('No text found in this image.'), text ? 'ok' : 'info');
      return { text, confidence };
    } catch(err){
      if(job !== jobId) return null;
      setText(output, 'Error: {msg}', { msg: String(err && err.message || err) });
      setProgress(0);
      setState('Error');
      throw err;
    } finally {
      onLog = null;
      if(job === jobId) setBusy(false);
    }
  }

  /* ─── Searchable PDF (spec §7.3, F-2) ───
     The geometry is js/lib/ocrpdf.js; here it becomes pdf-lib operators.
     Every page carries its picture plus one invisible (render mode 3) word
     per OCR box, each stretched to its box width (Tz), in the standard
     Helvetica, so nothing is embedded. Characters WinAnsi cannot hold read
     '?' in that invisible layer only (see ocrpdf.js). Saved without object
     streams, so older readers and plain byte checks see every object. */
  async function newSearchableDoc(){
    const L = await needLib('PDFLib');
    const pdf = await L.PDFDocument.create();
    const font = await pdf.embedFont(L.StandardFonts.Helvetica);
    const measure = (t, size) => { try { return font.widthOfTextAtSize(t, size); } catch(_){ return 0; } };
    const enc = (t) => { try { return font.encodeText(t); } catch(_){ return font.encodeText(t.replace(/[^\x20-\x7E]/g, '?')); } };
    function addPage(image, ptW, ptH, words, pxW, pxH){
      const page = pdf.addPage([ptW, ptH]);
      page.drawImage(image, { x: 0, y: 0, width: ptW, height: ptH });
      const ops = wordsToPdfOps(words, pxW, pxH, ptW, ptH, measure);
      if(!ops.length) return;
      const key = page.node.newFontDictionary(font.name, font.ref);
      const out = [L.pushGraphicsState(), L.beginText(), L.setTextRenderingMode(L.TextRenderingMode.Invisible)];
      for(const o of ops){
        out.push(L.setFontAndSize(key, o.size), L.setCharacterSqueeze(Math.max(1, Math.min(1000, o.hScale))),
          L.setTextMatrix(1, 0, 0, 1, o.x, o.y), L.showText(enc(o.text)));
      }
      out.push(L.endText(), L.popGraphicsState());
      page.pushOperators(...out);
    }
    return { L, pdf, addPage };
  }
  const baseName = (n) => String(n || 'document').replace(/\.[^.]+$/, '') || 'document';

  // One image: OCR it (again, if the rotation changed since), then one page
  // at the image's pixel size with the picture and its text.
  async function searchableImage(){
    if(!currentFile || busy) return;
    const file = currentFile;
    try {
      if(!lastResult || lastResult.file !== file || lastResult.rotation !== rotation) await runOCR();
      if(currentFile !== file || !lastResult || lastResult.file !== file) return;
      const r = lastResult;
      setBusy(true);
      // The picture as the words were read (rotated, never inverted). A
      // JPEG stays JPEG; anything else is drawn from a PNG.
      const jpeg = file.type === 'image/jpeg';
      const pic = await orient(file, false, jpeg ? 'image/jpeg' : 'image/png', 0.92);
      const { pdf, addPage } = await newSearchableDoc();
      const bytes = new Uint8Array(await pic.blob.arrayBuffer());
      const image = jpeg ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
      const size = ocrImagePageSize(pic.w, pic.h);
      addPage(image, size.w, size.h, r.words, r.w, r.h);
      const out = await pdf.save({ useObjectStreams: false });
      if(currentFile !== file) return;
      downloadBlob(new Blob([out], { type: 'application/pdf' }), baseName(file.name) + '.searchable.pdf');
    } catch(err){
      if(currentFile !== file) return;
      setText(output, 'Error: {msg}', { msg: String(err && err.message || err) });
      setState('Error');
    } finally {
      if(currentFile === file) setBusy(false);
    }
  }

  /* Every page of the PDF on screen: rendered at about 300 DPI, read, and
     rebuilt as its picture (JPEG, q 0.85) plus the invisible text, at the
     page's own size. The badge reads Page i / n; this same button cancels.
     Canvases are emptied as soon as each page is done. */
  function searchableDoc(){
    if(!doc) return Promise.resolve(null);
    // Cancel: the worker is thrown away so the page being read stops too.
    if(docRun){ docRun.cancel = true; dropWorker(); return Promise.resolve(null); }
    const d = doc, job = ++jobId;
    const run = { cancel: false };
    docRun = run;
    lastResult = null;
    setBusy(true);
    return queue(async () => {
      const texts = [];
      const stale = () => run.cancel || job !== jobId;
      try {
        if(stale()) return null;
        setRaw(output, '');
        setProgress(0);
        setState('Loading engine');
        onLog = (m) => { if(!m.status || m.status !== 'recognizing text') logToPanel(m); };
        const w = await getWorker();
        const { pdf, addPage } = await newSearchableDoc();
        await d.eachPage(async ({ num, total: n, canvas, ptW, ptH }) => {
          if(stale()) return false;
          setState('Page {i} / {n}', { i: num, n });
          setProgress((num - 1) / n * 100);
          onLog = (m) => { if(m.status === 'recognizing text') setProgress((num - 1 + (m.progress || 0)) / n * 100); };
          const jpg = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
          if(!jpg) throw new Error(T('Could not encode page {n}.').replace('{n}', num));
          const pxW = canvas.width, pxH = canvas.height;
          if(invertForOCR) invertCanvas(canvas);
          const { data } = await w.recognize(canvas, {}, OUTPUT);
          if(stale()) return false;
          const image = await pdf.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
          addPage(image, ptW, ptH, ocrWordsOf(data), pxW, pxH);
          const text = (data && data.text || '').trim();
          if(text){ texts.push(text); setRaw(output, texts.join('\n\n')); }
          setProgress(num / n * 100);
          return true;
        });
        if(stale()){ if(job === jobId){ setProgress(0); setState('Cancelled'); } return null; }
        const out = await pdf.save({ useObjectStreams: false });
        if(stale()) return null;
        downloadBlob(new Blob([out], { type: 'application/pdf' }), baseName(d.name) + '.searchable.pdf');
        if(!texts.length) setText(output, 'No text found in this image.');
        setProgress(100);
        setState('Done');
        toast(texts.length ? T('Text extracted') : T('No text found in this image.'), texts.length ? 'ok' : 'info');
        return out;
      } catch(err){
        if(job !== jobId) return null;
        if(run.cancel){ setProgress(0); setState('Cancelled'); return null; }
        setText(output, 'Error: {msg}', { msg: String(err && err.message || err) });
        setProgress(0);
        setState('Error');
        return null;
      } finally {
        onLog = null;
        if(docRun === run) docRun = null;
        if(job === jobId) setBusy(false); else syncPdfBtn();
      }
    });
  }

  /* The engine for another workspace (Redact's Find text, spec §12.1): the
     worker for the language and model chosen in this panel, queued behind
     any run of the panel's own, never touching the panel. source: anything
     worker.recognize takes (a canvas, a Blob). onProgress(key, vars) hears
     'Loading engine' and 'Recognizing… {pct}%'. Resolves to the raw result;
     the caller flattens the words it needs. */
  function readWords(source, onProgress){
    const say = typeof onProgress === 'function' ? onProgress : () => {};
    return queue(async () => {
      say('Loading engine');
      const w = await getWorker();
      onLog = (m) => { if(m.status === 'recognizing text') say('Recognizing… {pct}%', { pct: Math.round((m.progress || 0) * 100) }); };
      try {
        const { data } = await w.recognize(source, {}, OUTPUT);
        return data;
      } finally { onLog = null; }
    });
  }

  invView.addEventListener('change', () => { preview.classList.toggle('inverted', !!currentFile && invView.checked); });
  invOcr.addEventListener('change', () => { invertForOCR = invOcr.checked; });
  rotBtn.addEventListener('click', () => {
    if(!currentFile) return;
    rotation = (rotation + 90) % 360;
    syncRot();
  });
  runBtn.addEventListener('click', () => { runOCR().catch(() => {}); });
  pdfBtn.addEventListener('click', () => {
    if(docRun || doc) searchableDoc();
    else searchableImage();
  });

  $('ocr-download').addEventListener('click', () => {
    downloadBlob(new Blob([recognised()], { type: 'text/plain;charset=utf-8' }), 'ocr.txt');
  });

  window.addEventListener('beforeunload', () => {
    try { if(worker) worker.terminate(); } catch(_){}
  });

  resetUI();
  // The recognised text only: a status in its place (an error, "No text
  // found") is a key, never something to copy or save.
  function recognised(){ return output.dataset.tk ? '' : (output.textContent || ''); }
  return { load, run: runOCR, reset: resetUI, clear: clearOutput, text: recognised,
           // The options of the model chosen now (FilesTools.tesseractOptions).
           get TESS_OPTS(){ return optsFor(model()); },
           setDoc, searchableDoc, prefetch, markOpened, wasOpened: () => opened, readWords };
})();
