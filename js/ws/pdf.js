'use strict';
/* ════════════════════════════════════════════════════════════════
   1 · PDF → IMAGES  (vendored pdf.js, loaded on demand as a module)
   ════════════════════════════════════════════════════════════════ */
const PdfTool = (() => {
  let pdfjsLib = null;
  let pdfBytes = null, pdfName = 'document', results = [];
  // Every object URL handed to a card, so resetResults can give them back.
  let pageURLs = [];

  // Tesseract wants roughly 300 DPI; below that a real scan degrades badly.
  const OCR_DPI = 300;

  // The file screen owns the dropzone and the file chip now; this module only
  // owns the settings, the render loop and the page grid it fills.
  const grid = $('pdf-grid');
  const btnConvert = $('pdf-convert'), btnZip = $('pdf-zip');
  const bar = $('pdf-bar'), statusEl = $('pdf-status'), stateEl = $('pdf-state');

  async function lib(){
    if(pdfjsLib) return pdfjsLib;
    setText(statusEl, 'Loading PDF engine…');
    pdfjsLib = await import(new URL('vendor/pdfjs/pdf.min.mjs', location.href).href);
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.mjs', location.href).href;
    setText(statusEl, '');
    return pdfjsLib;
  }

  const getFmt = () => document.querySelector('input[name="pdf-fmt"]:checked').value;
  const getBg  = () => document.querySelector('input[name="pdf-bg"]:checked').value;

  document.querySelectorAll('input[name="pdf-fmt"]').forEach(r => r.addEventListener('change', () => {
    const f = getFmt();
    $('pdf-quality-group').classList.toggle('hidden', f === 'image/png');
    const alpha = f !== 'image/jpeg';
    $('pdf-bg-group').style.opacity = alpha ? '1' : '0.45';
    $('pdf-bg-group').style.pointerEvents = alpha ? 'auto' : 'none';
    if(!alpha) $('pdf-bg-white').checked = true;
  }));
  $('pdf-quality').addEventListener('input', () => $('pdf-quality-val').textContent = $('pdf-quality').value + '%');
  [['pdf-dpi-72',72],['pdf-dpi-150',150],['pdf-dpi-300',300]].forEach(([id,v]) =>
    $(id).addEventListener('change', () => $('pdf-scale').value = v));

  function resetResults(){
    results = [];
    pageURLs.forEach(u => URL.revokeObjectURL(u));
    pageURLs = [];
    grid.querySelectorAll('.rcard').forEach(c => c.remove());
    grid.classList.add('hidden');
    btnZip.disabled = true;
    setText(btnZip, 'Download ZIP');
  }

  /* One page to a blob — the render loop, the "show me page 1" preview and the
     OCR re-render all go through here so a previewed page and an exported one
     are the same pixels at the same settings.

     Only a blob comes back. This used to also return canvas.toDataURL(), which
     encoded every page a second time and then kept it as base64 — a third more
     bytes than the blob it duplicated, held for as long as the card was on
     screen. Callers that need to display a page make an object URL from the
     blob and are responsible for revoking it. */
  async function renderPage(pdf, num, dpi, format, bg, quality){
    const page = await pdf.getPage(num);
    const viewport = page.getViewport({ scale: dpi / 72 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if(bg === 'white' || format === 'image/jpeg'){
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise(r => canvas.toBlob(r, format, quality));
    if(!blob) throw new Error(T('Could not encode page {n}.').replace('{n}', num));
    return { blob, w: canvas.width, h: canvas.height };
  }

  /* Each render pass opens the document for itself. Holding one open and
     reusing it looks obviously cheaper, and it does not work: a second pass
     over a document that has already rendered never starts, and releasing the
     page proxies to avoid that breaks the pass still running. Parsing again
     costs far less than the duplicate encode this file used to do per page. */
  async function openDoc(){
    if(!pdfBytes) return null;
    const p = await lib();
    return p.getDocument({ data: pdfBytes.slice() }).promise;
  }

  /* The page the recogniser gets, rather than the page the screen shows.
     The preview is rendered at screen resolution and the export is rendered at
     whatever DPI was chosen for export — neither is necessarily good enough to
     read, so OCR gets its own pass at OCR_DPI, always PNG on white. */
  async function renderForOcr(num){
    const pdf = await openDoc();
    if(!pdf) return null;
    const dpi = Math.max(OCR_DPI, Math.min(600, parseInt($('pdf-scale').value, 10) || 0));
    try {
      const { blob } = await renderPage(pdf, num, dpi, 'image/png', 'white', 1);
      return new File([blob], `${pdfName}-page${num}.png`, { type: 'image/png' });
    } finally { try { await pdf.destroy(); } catch(_){} }
  }

  /* Every page for "Searchable PDF (all pages)" (spec §7.3): rendered on white
     at OCR_DPI, or less for a page so large that 300 DPI would pass
     OCR_MAX_PX, and handed to fn({ num, total, canvas, ptW, ptH }) with the
     page's size in points (as displayed, /Rotate applied). The canvas is
     emptied once fn is done with it; fn returning false stops the walk.
     One document is opened for the whole walk and destroyed after it. */
  const OCR_MAX_PX = 40e6;
  async function eachOcrPage(fn){
    const pdf = await openDoc();
    if(!pdf) return 0;
    try {
      const total = pdf.numPages;
      for(let num = 1; num <= total; num++){
        const page = await pdf.getPage(num);
        const v1 = page.getViewport({ scale: 1 });
        const dpi = Math.min(OCR_DPI, 72 * Math.sqrt(OCR_MAX_PX / Math.max(1, v1.width * v1.height)));
        const viewport = page.getViewport({ scale: dpi / 72 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        page.cleanup();
        let go;
        try { go = await fn({ num, total, canvas, ptW: v1.width, ptH: v1.height }); }
        finally { canvas.width = canvas.height = 0; }
        if(go === false) return num - 1;
      }
      return total;
    } finally { try { await pdf.destroy(); } catch(_){} }
  }

  /* Does page 1 carry text? Decides whether "Make searchable" leads the
     cards. null when it could not be read. */
  async function hasTextLayer(){
    let pdf = null;
    try {
      pdf = await openDoc();
      if(!pdf) return null;
      const page = await pdf.getPage(1);
      const tc = await page.getTextContent();
      return (tc.items || []).some(i => i.str && i.str.trim());
    } catch(_){ return null; }
    finally { if(pdf){ try { await pdf.destroy(); } catch(_){} } }
  }

  /* A new file disarms the old one before anything else: its bytes, its name,
     the Convert button, the page cards and their object URLs. The file screen
     only calls this for something sniffFile identified as a PDF by its magic
     bytes, so the MIME type and the extension are not checked again here (a
     PDF named "scan" with no type used to be refused and leave the previous
     PDF armed under the new name). `gen` stops an older load or an older
     Convert pass from painting over the new file. */
  let gen = 0;
  function disarm(){
    gen++;
    pdfBytes = null;
    pdfName = 'document';
    btnConvert.disabled = true;
    setBar(bar, 0);
    setText(stateEl, '');
    setText(statusEl, '');
    resetResults();
  }

  async function handleFile(file){
    disarm();
    if(!file) return null;
    const my = gen;
    let bytes;
    try { bytes = new Uint8Array(await file.arrayBuffer()); }
    catch(e){ if(my === gen) setText(statusEl, 'Error: {msg}', { msg: String(e && e.message || e) }); return null; }
    if(my !== gen) return null;
    pdfBytes = bytes;
    pdfName = file.name.replace(/\.[^.]+$/, '');
    setWsFile(file.name);
    btnConvert.disabled = false;
    setText(stateEl, 'Loaded');
    setText(statusEl, 'PDF loaded — ready to convert.');
    // A PDF should look like a file, not like a filename: page 1 is rendered
    // straight away at screen resolution so the screen has something to show
    // and something to hand to OCR.
    try {
      const pdf = await openDoc();
      const first = await renderPage(pdf, 1, 96, 'image/png', 'white', 1);
      const pageCount = pdf.numPages;
      try { await pdf.destroy(); } catch(_){}
      if(my !== gen) return null;
      setText(statusEl, '{n} page(s) — ready to convert.', { n: pageCount });
      return { pageCount, preview: first };
    } catch(e){
      if(my === gen) setText(statusEl, 'Error: {msg}', { msg: String(e && e.message || e) });
      return null;
    }
  }

  // The parser itself lives in js/lib/range.js (DOM-free, tested in node).
  const parseRange = (str, total) => parsePageRange(str, total);

  function addCard(num, url, blob, ext, w, h){
    const div = document.createElement('div');
    div.className = 'rcard';
    div.innerHTML = `
      <div class="thumb"><img alt="${T('Page')} ${num}"></div>
      <div class="rbody">
        <div class="rmeta"><span class="chip" data-tk="Page {n}" data-tv='{"n":${num}}'>${fmtT('Page {n}', { n: num })}</span><span>${w}×${h} · ${fmtBytes(blob.size)}</span></div>
        <div class="btn-row">
          <button class="btn btn-sm grow ocr-btn">🔍 <span data-tk="Extract text">${T('Extract text')}</span></button>
          <button class="btn btn-sm dl-btn" data-tk="Download">${T('Download')}</button>
        </div>
      </div>`;
    div.querySelector('img').src = url;
    div.querySelector('.dl-btn').addEventListener('click', () => downloadBlob(blob, `${pdfName}-page${num}.${ext}`));
    // Any rendered page can be handed to the recogniser on the same screen —
    // this is what used to mean "go to PDF → Images, download, then upload it
    // to OCR". The page is re-rendered for the recogniser rather than reusing
    // this card's blob, which may have been exported at 72 DPI.
    div.querySelector('.ocr-btn').addEventListener('click', () => AutoTool.ocrPage(num));
    // The thumbnail opens that page in the preview above, as the pager would.
    div.querySelector('.thumb').addEventListener('click', () => AutoTool.showPage(num));
    grid.appendChild(div);
  }

  btnConvert.addEventListener('click', async () => {
    if(!pdfBytes) return;
    const my = gen;
    btnConvert.disabled = true; btnZip.disabled = true;
    resetResults();
    // The grid's first appearance brings it into view (spec §5.1).
    const firstShow = grid.classList.contains('hidden');
    grid.classList.remove('hidden');
    setBar(bar, 0);
    setText(stateEl, 'Working');
    let pdf = null;
    try {
      pdf = await openDoc();
      const pages = parseRange($('pdf-range').value, pdf.numPages);
      if(!pages.length) throw new Error(T('No valid pages selected'));
      const format = getFmt(), bg = getBg();
      const dpi = Math.min(600, Math.max(36, parseInt($('pdf-scale').value, 10) || 150));
      const quality = (parseInt($('pdf-quality').value, 10) || 90) / 100;
      let done = 0;
      for(const num of pages){
        setText(statusEl, 'Rendering page {n} / {total}…', { n: num, total: pdf.numPages });
        const { blob, w, h } = await renderPage(pdf, num, dpi, format, bg, quality);
        if(my !== gen) return;   // another file was loaded: stop, paint nothing
        const ext = format.split('/')[1];
        const url = URL.createObjectURL(blob);
        pageURLs.push(url);
        addCard(num, url, blob, ext, w, h);
        results.push({ num, blob, ext });
        if(firstShow && !done) grid.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        done++;
        setBar(bar, done / pages.length * 100);
        await new Promise(r => setTimeout(r, 0));
        if(my !== gen) return;
      }
      setText(statusEl, 'Done — {n} page(s) converted.', { n: results.length });
      setText(stateEl, 'Done');
      toast(statusEl.textContent);   // announced: #toast is a live region
      btnZip.disabled = false;
      setText(btnZip, 'Download ZIP ({n})', { n: results.length });
    } catch(e){
      console.error(e);
      if(my !== gen) return;
      setText(statusEl, 'Error: {msg}', { msg: String(e && e.message || e) });
      setText(stateEl, 'Error');
    } finally {
      if(pdf){ try { await pdf.destroy(); } catch(_){} }
      if(my === gen) btnConvert.disabled = false;
    }
  });

  btnZip.addEventListener('click', async () => {
    if(!results.length) return;
    btnZip.disabled = true;
    setText(statusEl, 'Building ZIP…');
    const zip = await makeZip(results.map(({num, blob, ext}) => ({
      name: `${pdfName}-page${String(num).padStart(3, '0')}.${ext}`, blob
    })));
    downloadBlob(zip, `${pdfName}-images.zip`);
    setText(statusEl, 'ZIP ready ({size})', { size: fmtBytes(zip.size) });
    btnZip.disabled = false;
  });

  /* Any page at screen resolution, for the file screen's pager. Opens its own
     document (see openDoc) so it never touches a conversion in progress. */
  async function previewPage(num){
    const pdf = await openDoc();
    if(!pdf) return null;
    try { return await renderPage(pdf, num, 96, 'image/png', 'white', 1); }
    finally { try { await pdf.destroy(); } catch(_){} }
  }

  return { parseRange, open: handleFile, renderForOcr, previewPage, reset: disarm, eachOcrPage, hasTextLayer };
})();

/* Make searchable (spec §6.7, §7.3): a PDF whose page 1 has no text layer
   (a scan) leads with it; any other PDF keeps it in More. The file screen
   learns the answer after PdfTool.open and re-ranks the cards in place. */
const pdfTextLayer = new WeakMap();   // file → true | false | null
FilesApp.register({
  id: 'searchable', order: 40,
  accepts: (info) => info.kind === 'pdf',
  outcomes: (info, files) => {
    const scan = pdfTextLayer.get(files[0]) === false;
    return [Object.assign(scan ? { rank: 90 } : { more: true }, {
      id: 'searchable', icon: '🔎', title: T('Make searchable'),
      desc: scan ? T('Page 1 has no text: OCR every page into a PDF you can search and copy from.')
                 : T('Adds a text layer from OCR'),
      run: () => AutoTool.makeSearchable(),
    })];
  },
});
