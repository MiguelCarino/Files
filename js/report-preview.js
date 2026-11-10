/* ─── report preview ───
   Every printable report is shown before it is printed, as Topo's report
   dialog does. The frame holds the very document that prints (srcdoc, so it
   shares this page's origin and loads nothing from elsewhere). On screen it
   is laid out at A4's content width on a white sheet with 15 mm margins over
   grey, with a dashed line where each page should end (js/lib/printpages.js,
   an estimate: the paper is chosen in the print dialog). Those additions sit
   in an @media screen block, so printing the frame prints the document
   untouched. A stage narrower than a sheet (a phone) shows the sheet scaled
   down, as it will print, rather than the report reflowed.

   The dialog is the fleet's shared .rpv layout (carino-ui.css 18b): title,
   ✕, page count, file name and Print all in the left column, Print at its
   foot, the sheet on the right (#rp-stage, which rpFit measures).

   openReportPreview({ name, build, returnFocus }): build() returns (or
   resolves to) the report's full HTML; name is shown in the left column
   under the page count (what the report is of); returnFocus is where focus
   goes on close (default: what had focus, which is a hidden menu item when
   opened from a menu).
   Print prints the frame (→ Save as PDF in the dialog) and leaves the preview
   open for another copy; ✕, Esc or a click outside drops it, nothing kept.
   There is no separate Download: the report is HTML and the print dialog's
   Save as PDF is its file. The modal itself is CarinoUI.modal (focus trap,
   Esc, focus back). */
const RP_MM = 96 / 25.4;
const RP_A4 = { w: 210 * RP_MM, h: 297 * RP_MM, m: 15 * RP_MM };
const RP_SHEET_PX = Math.ceil(RP_A4.w) + 32;          // the sheet and the grey either side
const _rp = { seq: 0, cfg: null, ready: false };

function rpEl(id){ return document.getElementById(id); }

function rpPreviewHtml(html){
  const contentW = (RP_A4.w - 2 * RP_A4.m).toFixed(2);
  const m = RP_A4.m.toFixed(2);
  const css = `<style data-rp>
    @media screen {
      html{background:#d6d8dc !important;}
      body{box-sizing:content-box !important;width:${contentW}px !important;padding:${m}px !important;margin:16px auto 24px !important;
           background:#fff !important;position:relative !important;box-shadow:0 1px 6px rgba(0,0,0,.28);}
      .rp-break{position:absolute;left:0;right:0;height:0;border-top:1.5px dashed #9aa0a8;pointer-events:none;}
      .rp-break span{position:absolute;left:8px;top:3px;font:10px ui-monospace,Menlo,Consolas,monospace;color:#6b7280;}
    }
    @media print { .rp-break{display:none !important;} }
  </style>`;
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, css + '</head>') : css + html;
}

// The report's block boxes, as js/lib/printpages.js reads them.
function rpBoxes(doc, top){
  const win = doc.defaultView;
  const box = (el) => {
    const r = el.getBoundingClientRect();
    const cs = win.getComputedStyle(el);
    const avoid = el.tagName === 'TR' || cs.breakInside === 'avoid' || cs.pageBreakInside === 'avoid';
    const kids = Array.from(el.children).filter(k => {
      if(k.classList.contains('rp-break') || !k.getClientRects().length) return false;
      const d = win.getComputedStyle(k).display;
      return !/^inline/.test(d) && d !== 'contents' && d !== 'none';
    }).map(box);
    return { t: r.top - top, b: r.bottom - top, avoid, kids };
  };
  return Array.from(doc.body.children).filter(k => !k.classList.contains('rp-break') && k.getClientRects().length).map(box);
}

function rpFit(){
  const frame = rpEl('rp-frame'), stage = rpEl('rp-stage');
  if(!frame || !stage) return;
  Object.assign(frame.style, { width: '', height: '', transform: '', transformOrigin: '' });
  const w = stage.clientWidth;
  if(!w || w >= RP_SHEET_PX) return;
  const k = w / RP_SHEET_PX;
  Object.assign(frame.style, { width: RP_SHEET_PX + 'px', height: Math.round(stage.clientHeight / k) + 'px',
                               transform: 'scale(' + k + ')', transformOrigin: '0 0' });
}

async function rpRefresh(){
  const seq = ++_rp.seq;
  const frame = rpEl('rp-frame'), status = rpEl('rp-status'), go = rpEl('rp-print');
  _rp.ready = false;
  go.disabled = true;
  setText(status, 'Preparing the report…');
  let html;
  try { html = await _rp.cfg.build(); }
  catch(e){
    console.error(e);
    if(seq === _rp.seq) setText(status, 'Could not build the report.');
    return;
  }
  if(seq !== _rp.seq || !_rp.cfg) return;
  await new Promise(done => {
    let over = false;
    const shown = () => { if(over) return; over = true; frame.onload = null; done(); };
    frame.onload = shown;
    setTimeout(shown, 5000);   // a frame that never says it loaded
    frame.srcdoc = rpPreviewHtml(html);
  });
  if(seq !== _rp.seq) return;
  // Focus lands in the frame after a click on the sheet or a Print, and the
  // frame's keys never reach CarinoUI's Esc listener on this window.
  try {
    frame.contentDocument.addEventListener('keydown', (e) => {
      if(e.key === 'Escape' && !e.defaultPrevented){ e.preventDefault(); closeReportPreview(); }
    });
  } catch(e){ /* not same-origin: Esc still works from the page */ }
  let pages = 0;
  try {
    const d = frame.contentDocument;
    if(d.fonts) await d.fonts.ready;
    await Promise.all(Array.from(d.images).map(img => img.complete ? null : new Promise(r => { img.onload = img.onerror = r; })));
    if(seq !== _rp.seq) return;
    const r = d.body.getBoundingClientRect();
    const top = r.top + RP_A4.m;
    const breaks = printPageBreaks(rpBoxes(d, top), RP_A4.h - 2 * RP_A4.m);
    pages = breaks.length + 1;
    breaks.forEach((y, i) => {
      const line = d.createElement('div');
      line.className = 'rp-break';
      line.style.top = (RP_A4.m + y) + 'px';
      const tag = d.createElement('span');
      tag.textContent = fmtT('Page {n}', { n: i + 2 });
      line.appendChild(tag);
      d.body.appendChild(line);
    });
  } catch(e){ console.warn('Report preview: could not measure the pages.', e); }
  rpFit();
  if(pages === 1) setText(status, 'About 1 page on A4');
  else if(pages > 1) setText(status, 'About {n} pages on A4', { n: pages });
  else setText(status, '');
  _rp.ready = true;
  go.disabled = false;
}

function openReportPreview(cfg){
  const scrim = rpEl('rp-scrim');
  if(!scrim || !cfg || typeof cfg.build !== 'function') return Promise.resolve();
  _rp.cfg = cfg;
  setRaw(rpEl('rp-name'), cfg.name || '');
  CarinoUI.modal.open(scrim, { onClose: rpDrop, returnFocus: cfg.returnFocus || null });
  return rpRefresh();
}

function rpDrop(){
  _rp.seq++; _rp.cfg = null; _rp.ready = false;
  const frame = rpEl('rp-frame');
  if(frame){ frame.onload = null; frame.removeAttribute('srcdoc'); Object.assign(frame.style, { width: '', height: '', transform: '' }); }
  setRaw(rpEl('rp-name'), '');
  setText(rpEl('rp-status'), '');
  const go = rpEl('rp-print');
  if(go) go.disabled = true;
}

function closeReportPreview(){
  const scrim = rpEl('rp-scrim');
  if(scrim && window.CarinoUI && CarinoUI.modal.isOpen(scrim)) CarinoUI.modal.close(scrim, 'close');
  else rpDrop();
}

function rpPrint(){
  const frame = rpEl('rp-frame');
  if(!_rp.ready || !frame || !frame.contentWindow) return;
  try { frame.contentWindow.focus(); frame.contentWindow.print(); }
  catch(e){ console.error(e); toast(T('Could not build the report.'), 'err'); }
  // Back to the dialog, so Tab and Esc keep working once the print dialog is gone.
  const go = rpEl('rp-print');
  if(go && rpEl('rp-scrim') && !rpEl('rp-scrim').hidden) go.focus();
}

(function wireReportPreview(){
  const go = rpEl('rp-print');
  if(go) go.addEventListener('click', rpPrint);
  window.addEventListener('resize', () => { if(_rp.cfg) rpFit(); });
  // A language switch rebuilds the report in the new language.
  window.addEventListener('files:i18n', () => { if(_rp.cfg) rpRefresh(); });
})();
